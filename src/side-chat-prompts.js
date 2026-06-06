/**
 * Language Assistant Prompt Preset System.
 *
 * Tutor presets are JSON files that define BOTH the prompt content (system prompt
 * template, personality, rules) AND the available action buttons (Explain,
 * Translate, custom follow-ups, etc.). Action metadata is fully data-driven —
 * see `side-chat-actions.js` for the registry shape.
 *
 * Available dynamic macros (injected at call time via MacroDefinitionOptions):
 *   {{nihongoWord}}            — The word/phrase being asked about
 *   {{nihongoDictWord}}        — Dictionary/base form of the word
 *   {{nihongoReading}}         — Kana reading of the word (with parens if present)
 *   {{nihongoSentence}}        — The sentence or line containing the word
 *   {{nihongoParagraph}}       — The broader paragraph context
 *   {{nihongoPos}}             — Part of speech (if known from tokenizer/dict)
 *   {{nihongoKnownKanjiCount}} — How many kanji the user knows
 *   {{nihongoKnownKanji}}      — Comma-separated list of known kanji
 *   {{nihongoLearningKanjiCount}} — How many kanji the user is actively studying
 *   {{nihongoLearningKanji}}   — Comma-separated list of learning kanji
 *   {{nihongoAction}}          — The action id (preset-defined)
 *   {{nihongoUserMessage}}     — Free-form user input (for custom questions)
 *   {{nihongoPersonality}}     — Preset personality field
 *   {{nihongoDescription}}     — Preset description field
 *   {{nihongoRules}}           — Preset rules field
 *
 * Standard macros also available: {{user}}, {{char}}, etc.
 *
 * Preset JSON format (v3):
 * {
 *   "v": 3,
 *   "name": "Display Name",
 *   "description": "Short description (also available as {{nihongoDescription}} macro)",
 *   "personality": "Tutor personality (available as {{nihongoPersonality}} macro)",
 *   "rules": "General rules (available as {{nihongoRules}} macro)",
 *   "systemPrompt": "{{nihongoPersonality}}\n\n{{nihongoRules}}",
 *   "actions": {
 *     "explain": {
 *       "label": "Explain",
 *       "icon": "fa-circle-question",
 *       "visibility": ["tooltip", "selection"],
 *       "requiresDictionaryMatch": false,
 *       "system": "...",
 *       "user": "..."
 *     },
 *     "custom": { "label": "Ask", "visibility": ["manual"], "system": "...", "user": "..." }
 *   }
 * }
 *
 * v1/v2 presets are auto-migrated to v3 (action metadata defaults filled in).
 *
 * Storage:
 * - Bundled presets: data/presets/<id>.json (read-only, shipped with extension).
 *                    Listed in BUNDLED_PRESET_FILENAMES; the file basename is
 *                    the preset id and the JSON itself supplies name and
 *                    description. All bundled presets are non-deletable.
 *                    The 'default' id is the canonical first-run selection
 *                    and seeds the custom-action fallback.
 * - User presets:    user/files/nihongo-preset-<id>.json (uploaded via files endpoint).
 *                    Indexed in extension_settings.nihongo_helper.userPresets
 *                    so we don't depend on a directory-listing endpoint.
 */

import { chat_metadata, getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../../extensions.js';
import { EXTENSION_KEY, EXTENSION_NAME } from '../index.js';
import { buildActionRegistry, CUSTOM_ACTION_ID } from './side-chat-actions.js';

// ===== Types =====

/**
 * @typedef {Object} TutorPreset
 * @property {number} v - Format version (3)
 * @property {string} name - Display name
 * @property {string} description
 * @property {string} personality
 * @property {string} rules
 * @property {string} systemPrompt - Stable system prompt template (cacheable)
 * @property {string} [feedback] - Optional tutor-specific Writing Feedback guidance (tone/emphasis only).
 * @property {Record<string, any>} actions - Raw per-action definitions (validated by side-chat-actions)
 */

/**
 * @typedef {Object} PresetEntry
 * @property {string} id          Stable id (slug). Doubles as the file basename for user presets.
 * @property {string} name        Display name
 * @property {string} description Short description
 * @property {string} path        URL to fetch the preset JSON from
 * @property {boolean} bundled    True for bundled presets
 */

/**
 * @typedef {Object} UserPresetIndexEntry
 * @property {string} id
 * @property {string} fileName    e.g. "nihongo-preset-<id>.json"
 * @property {string} name
 * @property {string} description
 * @property {string} importedAt  ISO timestamp
 */

// ===== Constants =====

const CURRENT_VERSION = 3;
const DEFAULT_PRESET_ID = 'default';

const USER_PRESET_FILENAME_PREFIX = 'nihongo-preset-';
const USER_PRESET_FILENAME_SUFFIX = '.json';

/**
 * Filenames of presets shipped with the extension under `data/presets/`.
 * Each filename's basename (sans `.json`) becomes its preset id; the display
 * name, description, and content all come from the loaded JSON — nothing
 * else is hardcoded here. To ship a new bundled preset, drop a JSON file in
 * `data/presets/` and add its filename to this list.
 *
 * The id `'default'` is the canonical first-run selection AND seeds the
 * custom-action fallback used when an active preset omits its own `custom`
 * action. All bundled presets are non-deletable.
 */
const BUNDLED_PRESET_FILENAMES = Object.freeze([
    'default.json',
    'immersion.json',
    'strict.json',
    'anime-geek.json',
]);

/**
 * URL to fetch a bundled preset JSON from. Built lazily so we don't read
 * `EXTENSION_NAME` at module load time (it's exported from a sibling module
 * that may not be initialized yet during the import cycle).
 *
 * @param {string} filename
 * @returns {string}
 */
const bundledPresetUrl = (filename) =>
    `/scripts/extensions/third-party/${EXTENSION_NAME}/data/presets/${filename}`;

/**
 * @param {string} filename e.g. `'default.json'`
 * @returns {string} Preset id, e.g. `'default'`
 */
const presetIdFromFilename = (filename) =>
    filename.replace(/\.json$/i, '');

// ===== State =====

/**
 * @typedef {Object} BundledPresetRecord
 * @property {string} id
 * @property {string} filename
 * @property {string} url
 * @property {TutorPreset} data
 */

/**
 * Bundled presets keyed by id, loaded once at init from `data/presets/<filename>`.
 * Populated by `initPresets()`.
 * @type {Map<string, BundledPresetRecord>}
 */
let bundledPresets = new Map();

/** Cached fallback action object derived from the `'default'` bundled preset's `custom` action. */
/** @type {import('./side-chat-actions.js').ChatAction|null} */
let bundledCustomFallback = null;

/** Currently active preset (raw JSON, post-migration). */
/** @type {TutorPreset|null} */
let activePreset = null;

/** Id of the currently active preset (null when nothing is loaded). */
/** @type {string|null} */
let activePresetId = null;

/** Active preset's normalized action registry. */
/** @type {{ actions: import('./side-chat-actions.js').ChatAction[], byId: Map<string, import('./side-chat-actions.js').ChatAction> }} */
let activeRegistry = { actions: [], byId: new Map() };

/** Discovered preset list (bundled + user). Populated by `refreshPresetList()` during init. */
/** @type {PresetEntry[]} */
let presetList = [];

// ===== Public API: Reads =====

/** @returns {string} */
export function getMainSystemPrompt() {
    return activePreset?.systemPrompt || '';
}

/**
 * @param {string} actionId
 * @returns {string}
 */
export function getActionInstructions(actionId) {
    const action = getAction(actionId) || getAction(CUSTOM_ACTION_ID);
    return action?.system || '';
}

/**
 * @param {string} actionId
 * @returns {string}
 */
export function getUserPrompt(actionId) {
    const action = getAction(actionId) || getAction(CUSTOM_ACTION_ID);
    return action?.user || '';
}

/**
 * Returns the action with the given id from the active registry, or null.
 * @param {string} actionId
 * @returns {import('./side-chat-actions.js').ChatAction|null}
 */
export function getAction(actionId) {
    return activeRegistry.byId.get(actionId) || null;
}

/**
 * Returns the active preset's normalized action list (read-only).
 * @returns {import('./side-chat-actions.js').ChatAction[]}
 */
export function getActiveActions() {
    return activeRegistry.actions;
}

/**
 * Dynamic macros for preset content fields ({{nihongoPersonality}} etc).
 * @returns {Record<string, import('../../../../macros/engine/MacroEnv.types.js').DynamicMacroValue>}
 */
export function getPresetFieldMacros() {
    return {
        nihongoPersonality: {
            description: 'Tutor personality text from the active preset',
            handler: () => activePreset?.personality || '',
        },
        nihongoDescription: {
            description: 'Preset description text',
            handler: () => activePreset?.description || '',
        },
        nihongoRules: {
            description: 'General rules from the active preset',
            handler: () => activePreset?.rules || '',
        },
    };
}

/** @returns {PresetEntry[]} */
export function getPresetList() {
    return presetList;
}

/** @returns {TutorPreset|null} */
export function getActivePreset() {
    return activePreset;
}

/**
 * Returns the active preset's tutor-specific Writing Feedback guidance, or an
 * empty string when the preset doesn't define any (the feedback engine then
 * uses a neutral bundled fallback). This influences review *style* only — the
 * machine-readable contract is owned by the extension, not the preset.
 * @returns {string}
 */
export function getActivePresetFeedbackGuidance() {
    return (activePreset && typeof activePreset.feedback === 'string') ? activePreset.feedback : '';
}

/**
 * Id of the preset currently loaded into `activePreset`. Returns null when
 * nothing has been loaded yet.
 * @returns {string|null}
 */
export function getActivePresetId() {
    return activePresetId;
}

// ===== Public API: Chat-bound preset (per ST chat) =====

/**
 * Per-ST-chat preset binding lives under `chat_metadata[EXTENSION_KEY].chatPresetId`.
 * When set, it overrides the user's default preset id (from extension settings)
 * for the duration of that chat. The default acts as the fallback for any chat
 * that hasn't been pinned to a specific tutor.
 *
 *   Effective preset id = (chat-bound id) || (settings default id) || 'default'
 *
 * Storage uses `saveMetadataDebounced()` (the standard SillyTavern extension
 * pattern — see `public/scripts/extensions.js`), so the binding survives chat
 * reload / app restart and rides along when the chat is exported.
 */

/** Field used inside `chat_metadata[EXTENSION_KEY]` to store the bound preset id. */
const CHAT_META_PRESET_FIELD = 'chatPresetId';

/**
 * Returns the chat-scoped preset id pinned to the currently loaded ST chat,
 * or null when the chat is unpinned (uses the default).
 * @returns {string|null}
 */
export function getChatBoundPresetId() {
    const ns = chat_metadata && chat_metadata[EXTENSION_KEY];
    if (!ns || typeof ns !== 'object') return null;
    const id = ns[CHAT_META_PRESET_FIELD];
    return (typeof id === 'string' && id) ? id : null;
}

/**
 * Pins a preset id to the currently loaded ST chat. The next time this chat
 * is opened the bound preset takes over from the settings default.
 * @param {string} presetId
 */
export function setChatBoundPresetId(presetId) {
    if (!chat_metadata[EXTENSION_KEY] || typeof chat_metadata[EXTENSION_KEY] !== 'object') {
        chat_metadata[EXTENSION_KEY] = {};
    }
    chat_metadata[EXTENSION_KEY][CHAT_META_PRESET_FIELD] = presetId;
    saveMetadataDebounced();
}

/**
 * Removes any preset binding from the currently loaded ST chat. The chat
 * reverts to following the settings default.
 */
export function clearChatBoundPresetId() {
    const ns = chat_metadata && chat_metadata[EXTENSION_KEY];
    if (ns && typeof ns === 'object' && CHAT_META_PRESET_FIELD in ns) {
        delete ns[CHAT_META_PRESET_FIELD];
        saveMetadataDebounced();
    }
}

/**
 * The user's default preset id (per-account, in extension settings).
 * This is what unbound chats follow. Falls back to the canonical bundled
 * `'default'` if the setting is missing or invalid.
 * @returns {string}
 */
export function getDefaultPresetId() {
    const settings = extension_settings[EXTENSION_KEY];
    const id = settings?.chatPresetId;
    return (typeof id === 'string' && id) ? id : DEFAULT_PRESET_ID;
}

/**
 * Resolves the preset id that should currently be active: chat-bound first,
 * settings default second, hard-coded `'default'` last.
 * @returns {string}
 */
export function getEffectivePresetId() {
    return getChatBoundPresetId() || getDefaultPresetId();
}

// ===== Public API: Init / Loading =====

/**
 * Loads all bundled presets, discovers user presets, and activates the
 * requested preset (falling back to the canonical `'default'` bundled).
 * @param {string} [presetId]
 */
export async function initPresets(presetId) {
    // Load all bundled presets in parallel. A failure on one (HTTP error,
    // malformed JSON) is non-fatal — it's just filtered out and the others
    // remain usable.
    bundledPresets = new Map();
    const loaded = await Promise.all(BUNDLED_PRESET_FILENAMES.map(async (filename) => {
        const id = presetIdFromFilename(filename);
        const url = bundledPresetUrl(filename);
        const data = await fetchPresetFromUrl(url);
        return data ? /** @type {BundledPresetRecord} */ ({ id, filename, url, data }) : null;
    }));
    for (const entry of loaded) {
        if (entry) bundledPresets.set(entry.id, entry);
    }

    // The canonical `default` preset seeds the custom-action fallback used
    // when an active preset omits its own `custom` action.
    const defaultBundled = bundledPresets.get(DEFAULT_PRESET_ID);
    if (defaultBundled) {
        const reg = buildActionRegistry(defaultBundled.data.actions, null);
        bundledCustomFallback = reg.byId.get(CUSTOM_ACTION_ID) || null;
    } else {
        bundledCustomFallback = null;
    }

    refreshPresetList();
    await loadPreset(presetId || DEFAULT_PRESET_ID);
}

/**
 * Loads a preset by id (bundled or user). Falls back to the bundled default
 * on failure.
 * @param {string} presetId
 * @returns {Promise<boolean>}
 */
export async function loadPreset(presetId) {
    const entry = presetList.find(p => p.id === presetId);
    const path = entry?.path;

    const data = await fetchPresetFromUrl(path);
    if (!data) {
        if (presetId !== DEFAULT_PRESET_ID) {
            console.warn(`[${EXTENSION_NAME}] Falling back to default preset.`);
            return loadPreset(DEFAULT_PRESET_ID);
        }
        // Even the default failed — keep an empty registry so the extension stays usable.
        activePreset = null;
        activePresetId = null;
        activeRegistry = buildActionRegistry({}, bundledCustomFallback);
        return false;
    }

    activePreset = data;
    activePresetId = entry?.id || presetId;
    activeRegistry = buildActionRegistry(data.actions, bundledCustomFallback);
    console.debug(`[${EXTENSION_NAME}] Loaded preset: ${data.name} (v${data.v}, ${activeRegistry.actions.length} action(s))`);
    return true;
}

/**
 * Reloads the active preset from disk (e.g. after import). No-op if nothing
 * is active.
 */
export async function reloadActivePreset() {
    const current = activePreset?.name;
    const id = presetList.find(p => activePreset && p.name === current)?.id;
    if (id) await loadPreset(id);
}

// ===== Public API: Import / Export =====

/**
 * Returns the active preset as a pretty-printed JSON string for download.
 * @returns {string|null}
 */
export function exportActivePreset() {
    if (!activePreset) return null;
    return JSON.stringify(activePreset, null, 4);
}

/**
 * Imports a preset from a JSON string. Validates the basic shape, slugifies
 * the name, resolves id collisions, uploads to the files endpoint, and
 * registers it in the user-preset index. The new preset becomes selectable
 * immediately.
 *
 * @param {string} jsonText Raw JSON content
 * @returns {Promise<PresetEntry>} The newly registered preset entry
 * @throws {Error} On parse error, validation failure, or upload failure
 */
export async function importPresetFromJson(jsonText) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        throw new Error(`Invalid JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Preset must be a JSON object.');
    }

    const migrated = migrateToCurrent(parsed);
    if (!migrated.actions || typeof migrated.actions !== 'object') {
        throw new Error('Preset has no "actions" object.');
    }

    // Sanity-check the action set: at least one valid action OR a usable custom.
    const trial = buildActionRegistry(migrated.actions, null);
    if (trial.actions.length === 0 && !bundledCustomFallback) {
        throw new Error('Preset contains no valid actions.');
    }

    const baseName = (typeof migrated.name === 'string' && migrated.name.trim())
        ? migrated.name.trim()
        : 'Imported Preset';
    migrated.name = baseName;
    if (typeof migrated.description !== 'string') migrated.description = '';

    const baseId = slugifyId(baseName);
    const id = uniquifyId(baseId);
    const fileName = `${USER_PRESET_FILENAME_PREFIX}${id}${USER_PRESET_FILENAME_SUFFIX}`;

    // Upload via the files endpoint. The endpoint disallows path separators in
    // names, so we use a flat `nihongo-preset-<id>.json` naming convention.
    const json = JSON.stringify(migrated, null, 4);
    const base64 = btoa(unescape(encodeURIComponent(json)));

    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: fileName, data: base64 }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Upload failed: HTTP ${res.status} ${body}`);
    }
    const uploadResult = await res.json().catch(() => ({}));
    const uploadedPath = uploadResult.path || `user/files/${fileName}`;

    // Register in the index.
    const index = getUserPresetIndex();
    const existingIdx = index.findIndex(e => e.id === id);
    /** @type {UserPresetIndexEntry} */
    const entry = {
        id,
        fileName,
        name: migrated.name,
        description: migrated.description || '',
        importedAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) index[existingIdx] = entry;
    else index.push(entry);
    saveUserPresetIndex(index);

    refreshPresetList();

    return /** @type {PresetEntry} */ ({
        id,
        name: entry.name,
        description: entry.description,
        path: '/' + uploadedPath.replace(/^\/+/, ''),
        bundled: false,
    });
}

/**
 * Deletes a user preset (file + index entry). All bundled presets are
 * non-deletable.
 * @param {string} presetId
 * @returns {Promise<boolean>}
 */
export async function deleteUserPreset(presetId) {
    if (bundledPresets.has(presetId)) return false;
    const index = getUserPresetIndex();
    const entry = index.find(e => e.id === presetId);
    if (!entry) return false;

    try {
        await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: `user/files/${entry.fileName}` }),
        });
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Could not delete preset file (may already be gone):`, err);
    }

    saveUserPresetIndex(index.filter(e => e.id !== presetId));
    refreshPresetList();
    return true;
}

/**
 * Returns true if the preset id refers to a user-imported preset (deletable).
 * @param {string} presetId
 * @returns {boolean}
 */
export function isUserPreset(presetId) {
    return getUserPresetIndex().some(e => e.id === presetId);
}

// ===== Internal: Discovery =====

/**
 * Rebuilds the in-memory `presetList` from the loaded bundled presets and
 * the user-preset index. Names and descriptions for bundled entries come
 * from their loaded JSON, not from any hardcoded metadata.
 */
function refreshPresetList() {
    /** @type {PresetEntry[]} */
    const list = [];
    for (const entry of bundledPresets.values()) {
        list.push({
            id: entry.id,
            name: entry.data.name || entry.id,
            description: entry.data.description || '',
            path: entry.url,
            bundled: true,
        });
    }
    for (const entry of getUserPresetIndex()) {
        list.push({
            id: entry.id,
            name: entry.name || entry.id,
            description: entry.description || '',
            path: `/user/files/${entry.fileName}`,
            bundled: false,
        });
    }
    presetList = list;
}

/**
 * Reads the user-preset index from extension_settings. Always returns an array.
 * @returns {UserPresetIndexEntry[]}
 */
function getUserPresetIndex() {
    const settings = extension_settings[EXTENSION_KEY];
    if (!settings) return [];
    if (!Array.isArray(settings.userPresets)) settings.userPresets = [];
    return settings.userPresets;
}

/**
 * Persists the user-preset index back to extension_settings.
 * @param {UserPresetIndexEntry[]} index
 */
function saveUserPresetIndex(index) {
    if (!extension_settings[EXTENSION_KEY]) extension_settings[EXTENSION_KEY] = {};
    extension_settings[EXTENSION_KEY].userPresets = index;
    saveSettingsDebounced();
}

// ===== Internal: Loading helpers =====

/**
 * Fetches a preset JSON from a URL and migrates it to the current schema.
 * @param {string} url
 * @returns {Promise<TutorPreset|null>}
 */
async function fetchPresetFromUrl(url) {
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data || typeof data !== 'object') throw new Error('Not a JSON object');
        return migrateToCurrent(data);
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Failed to load preset from ${url}:`, err);
        return null;
    }
}

/**
 * Migrates any older preset format to the current one. Cheap, non-strict.
 * Action metadata defaults are filled in by `buildActionRegistry`, so we
 * only normalize top-level fields here.
 *
 * @param {any} data
 * @returns {TutorPreset}
 */
function migrateToCurrent(data) {
    const v = Number(data.v) || 1;
    const out = {
        v: CURRENT_VERSION,
        name: typeof data.name === 'string' ? data.name : 'Unnamed Preset',
        description: typeof data.description === 'string' ? data.description : '',
        personality: typeof data.personality === 'string' ? data.personality : '',
        rules: typeof data.rules === 'string' ? data.rules : '',
        systemPrompt: typeof data.systemPrompt === 'string' ? data.systemPrompt : '',
        // Optional tutor-specific Writing Feedback guidance. Absent in older
        // presets; the feedback engine falls back to a neutral bundled default.
        feedback: typeof data.feedback === 'string' ? data.feedback : '',
        actions: (data.actions && typeof data.actions === 'object') ? data.actions : {},
    };

    // v1: no systemPrompt template, personality was prepended to action systems.
    if (v < 2 && !out.systemPrompt) {
        out.systemPrompt = '{{nihongoPersonality}}';
    }
    // v2: actions had only { system, user }. Action metadata (label/icon/visibility)
    //     is supplied as defaults by buildActionRegistry — no preprocessing needed.
    if (!out.systemPrompt) {
        out.systemPrompt = '{{nihongoPersonality}}\n\n{{nihongoRules}}';
    }
    return out;
}

// ===== Internal: ID helpers =====

/**
 * Converts a display name to a filesystem-safe slug usable as both an id
 * and a filename component. Falls back to a timestamp-based id if the name
 * has no usable characters. Slugs that collide with a bundled preset id
 * get a `-user` suffix so the import never silently shadows a bundled.
 *
 * @param {string} name
 * @returns {string}
 */
function slugifyId(name) {
    let s = name.toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
    if (!s) s = `preset-${Date.now().toString(36)}`;
    if (bundledPresets.has(s)) s = `${s}-user`;
    return s.slice(0, 64);
}

/**
 * Returns an id that does not collide with any bundled preset or existing
 * user preset, by appending a `-2`, `-3`, ... suffix.
 * @param {string} baseId
 * @returns {string}
 */
function uniquifyId(baseId) {
    const taken = new Set();
    for (const id of bundledPresets.keys()) taken.add(id);
    for (const e of getUserPresetIndex()) taken.add(e.id);
    if (!taken.has(baseId)) return baseId;
    let n = 2;
    while (taken.has(`${baseId}-${n}`)) n++;
    return `${baseId}-${n}`;
}
