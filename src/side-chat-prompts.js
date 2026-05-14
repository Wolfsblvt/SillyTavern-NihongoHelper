/**
 * Language Assistant Prompt Preset System.
 *
 * Presets are JSON files with a stable system prompt template, preset content fields,
 * and per-action system/user prompt templates. Templates use {{macro}} syntax processed
 * by substituteParams with dynamicMacros.
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
 *   {{nihongoAction}}          — The action type (explain, translate, etc.)
 *   {{nihongoUserMessage}}     — Free-form user input (for custom questions)
 *   {{nihongoPersonality}}     — Preset personality field
 *   {{nihongoDescription}}     — Preset description field
 *   {{nihongoRules}}           — Preset rules field
 *
 * Standard macros also available: {{user}}, {{char}}, etc.
 *
 * Preset JSON format (v2):
 * {
 *   "v": 2,
 *   "name": "Display Name",
 *   "description": "Short description (also available as {{nihongoDescription}} macro)",
 *   "personality": "Tutor personality (available as {{nihongoPersonality}} macro)",
 *   "rules": "General rules (available as {{nihongoRules}} macro)",
 *   "systemPrompt": "{{nihongoPersonality}}\n\n{{nihongoRules}}",
 *   "actions": {
 *     "explain": { "system": "...", "user": "..." },
 *     ...
 *   }
 * }
 *
 * v1 presets are auto-migrated: personality becomes the systemPrompt template directly.
 */

import { getRequestHeaders } from '../../../../../script.js';
import { EXTENSION_NAME } from '../index.js';

// ===== Types =====

/**
 * @typedef {Object} TutorPreset
 * @property {number} v - Format version (2)
 * @property {string} name - Display name
 * @property {string} description - Short description ({{nihongoDescription}} macro)
 * @property {string} personality - Tutor personality text ({{nihongoPersonality}} macro)
 * @property {string} rules - General rules text ({{nihongoRules}} macro)
 * @property {string} systemPrompt - Stable system prompt template composing preset fields via macros
 * @property {Record<string, {system: string, user: string}>} actions - Per-action prompts
 */

/**
 * @typedef {Object} PresetEntry
 * @property {string} id - Unique ID (filename without extension)
 * @property {string} name - Display name
 * @property {string} description - Short description
 * @property {string} path - File path for loading
 */

// ===== Constants =====

const PRESETS_DIR = 'user/files/nihongo-presets';
const BUNDLED_PRESET_PATH = '/scripts/extensions/third-party/SillyTavern-NihongoHelper/data/presets/default.json';
const DEFAULT_PRESET_ID = 'default';

// ===== State =====

/** @type {TutorPreset|null} */
let activePreset = null;

/** @type {PresetEntry[]} */
let presetList = [{ id: DEFAULT_PRESET_ID, name: 'Default Tutor', description: 'Concise, clear Japanese tutor', path: BUNDLED_PRESET_PATH }];

// ===== Action Metadata =====

/**
 * @typedef {Object} ChatAction
 * @property {string} id - Unique action identifier
 * @property {string} label - Display label for buttons/UI
 * @property {string} icon - FontAwesome icon class
 * @property {string} description - Short description for settings UI
 */

/** @type {ChatAction[]} */
export const CHAT_ACTIONS = [
    { id: 'explain', label: 'Explain', icon: 'fa-circle-question', description: 'Explain a word\'s meaning in context' },
    { id: 'translate', label: 'Translate', icon: 'fa-language', description: 'Translate a sentence or phrase' },
    { id: 'alternatives', label: 'Alternatives', icon: 'fa-arrows-split-up-and-left', description: 'Find synonyms and alternative expressions' },
    { id: 'grammar', label: 'Grammar', icon: 'fa-spell-check', description: 'Explain a grammar pattern' },
];

// ===== Public API =====

/**
 * Gets the action definition by id.
 * @param {string} actionId
 * @returns {ChatAction|undefined}
 */
export function getChatAction(actionId) {
    return CHAT_ACTIONS.find(a => a.id === actionId);
}

/**
 * Gets the stable main system prompt template (personality + rules, no action-specific content).
 * This stays identical across all turns in a session — cacheable by LLM providers.
 * @returns {string}
 */
export function getMainSystemPrompt() {
    const preset = activePreset;
    if (!preset) return '';
    return preset.systemPrompt || '';
}

/**
 * Gets the action-specific system instructions (injected at depth, before user message).
 * @param {string} actionId
 * @returns {string}
 */
export function getActionInstructions(actionId) {
    const preset = activePreset;
    if (!preset) return '';
    const actionPrompts = preset.actions[actionId] || preset.actions['custom'] || {};
    return actionPrompts.system || '';
}

/**
 * Gets the user prompt template for an action.
 * @param {string} actionId
 * @returns {string}
 */
export function getUserPrompt(actionId) {
    const preset = activePreset;
    if (!preset) return '';
    const actionPrompts = preset.actions[actionId] || preset.actions['custom'] || {};
    return actionPrompts.user || '';
}

/**
 * Returns dynamic macros for preset content fields.
 * These resolve preset fields like personality, description, rules into macro values.
 * @returns {Record<string, import('../../../../macros/engine/MacroEnv.types.js').DynamicMacroValue>}
 */
export function getPresetFieldMacros() {
    const preset = activePreset;
    return {
        nihongoPersonality: {
            description: 'Tutor personality text from the active preset',
            handler: () => preset?.personality || '',
        },
        nihongoDescription: {
            description: 'Preset description text',
            handler: () => preset?.description || '',
        },
        nihongoRules: {
            description: 'General rules from the active preset',
            handler: () => preset?.rules || '',
        },
    };
}

/**
 * Returns the list of available presets.
 * @returns {PresetEntry[]}
 */
export function getPresetList() {
    return presetList;
}

/**
 * Returns the currently active preset.
 * @returns {TutorPreset|null}
 */
export function getActivePreset() {
    return activePreset;
}

/**
 * Loads a preset by ID. Falls back to bundled default if not found.
 * @param {string} presetId
 * @returns {Promise<boolean>} Whether the load was successful
 */
export async function loadPreset(presetId) {
    const entry = presetList.find(p => p.id === presetId);
    const path = entry?.path || BUNDLED_PRESET_PATH;

    try {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data || !data.actions) throw new Error('Invalid preset format');
        activePreset = data.v === 2 ? data : migrateV1ToV2(data);
        console.debug(`[${EXTENSION_NAME}] Loaded preset: ${activePreset.name} (v${activePreset.v})`);
        return true;
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Failed to load preset "${presetId}":`, err);
        // Fall back to bundled default
        if (presetId !== DEFAULT_PRESET_ID) {
            return loadPreset(DEFAULT_PRESET_ID);
        }
        return false;
    }
}

/**
 * Discovers available presets from the user's files directory.
 * Always includes the bundled default.
 * @returns {Promise<PresetEntry[]>}
 */
export async function discoverPresets() {
    // Start with the bundled default
    const list = [{ id: DEFAULT_PRESET_ID, name: 'Default Tutor', description: 'Concise, clear Japanese tutor', path: BUNDLED_PRESET_PATH }];

    try {
        // Check if user presets directory exists
        const verifyRes = await fetch('/api/files/verify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ urls: [PRESETS_DIR] }),
        });
        if (!verifyRes.ok) {
            presetList = list;
            return list;
        }

        // List files in the presets directory
        const listRes = await fetch('/api/files/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: PRESETS_DIR }),
        });
        if (listRes.ok) {
            const files = await listRes.json();
            for (const file of files) {
                if (!file.name?.endsWith('.json') || file.name === 'default.json') continue;
                const id = file.name.replace('.json', '');
                const path = `/${PRESETS_DIR}/${file.name}`;
                // Try to read name/description from the file
                try {
                    const presetRes = await fetch(path, { cache: 'no-store' });
                    if (presetRes.ok) {
                        const data = await presetRes.json();
                        if (data?.v === 1 || data?.v === 2) {
                            list.push({ id, name: data.name || id, description: data.description || '', path });
                        }
                    }
                } catch { /* skip invalid presets */ }
            }
        }
    } catch (err) {
        console.debug(`[${EXTENSION_NAME}] Preset discovery error (non-critical):`, err);
    }

    presetList = list;
    return list;
}

/**
 * Initializes the preset system — discovers presets and loads the active one.
 * @param {string} [presetId] - ID of preset to load (from settings)
 */
export async function initPresets(presetId) {
    await discoverPresets();
    await loadPreset(presetId || DEFAULT_PRESET_ID);
}

// ===== Internal =====

/**
 * Migrates a v1 preset to v2 format.
 * v1 had a combined personality field prepended to all action system prompts.
 * v2 splits this into a systemPrompt template + separate personality/rules fields.
 * @param {Object} v1 - v1 preset data
 * @returns {TutorPreset}
 */
function migrateV1ToV2(v1) {
    return {
        v: 2,
        name: v1.name || 'Unnamed Preset',
        description: v1.description || '',
        personality: v1.personality || '',
        rules: '',
        systemPrompt: '{{nihongoPersonality}}',
        actions: v1.actions || {},
    };
}
