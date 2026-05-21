import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { EXTENSION_KEY, EXTENSION_NAME } from '../index.js';

/**
 * Unified per-kanji learning state.
 *
 * Persistent shape (extension_settings[EXTENSION_KEY].kanjiState):
 *   {
 *     "食": { state: "learning", learningSince: ISO, updatedAt: ISO },
 *     "見": { state: "known",    knownSince: ISO,    updatedAt: ISO,
 *             learningSince?: ISO  // preserved if it was learning before becoming known }
 *   }
 *
 * Only kanji that are NOT 'unknown' are stored. Removing the entry == unknown.
 *
 * State semantics:
 *   - `known` always supersedes `learning` (use case: "I know this").
 *   - Setting `learning` on a `known` kanji demotes it (state -> learning, knownSince cleared).
 *   - Setting `unknown` deletes the entry entirely.
 *   - Timestamps are preserved across transitions where they make sense:
 *       - learningSince is set the first time a kanji becomes learning, retained when it
 *         is later promoted to known. Cleared only on full reset to unknown.
 *       - knownSince is set the first time a kanji becomes known. Cleared on demotion
 *         to learning or full reset.
 */

/** @typedef {'unknown'|'learning'|'known'} KanjiStateName */

/**
 * @typedef {Object} KanjiStateEntry
 * @property {KanjiStateName} state    Current state ('learning' or 'known' — 'unknown' is implicit)
 * @property {string} [learningSince]  ISO date when first marked as learning
 * @property {string} [knownSince]     ISO date when first marked as known
 * @property {string} updatedAt        ISO date of last state mutation
 */

/** @type {Map<string, KanjiStateEntry>} */
let kanjiState = new Map();
let loaded = false;

/**
 * Reads kanji state from extension settings into the in-memory map.
 * Migrates the legacy `knownKanji` shape (array of chars OR object char→ISO date)
 * if present, then deletes the legacy key.
 * Idempotent — safe to call multiple times.
 */
export function loadKanjiState() {
    extension_settings[EXTENSION_KEY] = extension_settings[EXTENSION_KEY] || {};
    const settings = extension_settings[EXTENSION_KEY];

    kanjiState = new Map();

    const raw = settings.kanjiState;
    if (raw && typeof raw === 'object') {
        for (const [ch, entry] of Object.entries(raw)) {
            if (!ch || !entry || typeof entry !== 'object') continue;
            if (entry.state !== 'learning' && entry.state !== 'known') continue;
            kanjiState.set(ch, {
                state: entry.state,
                learningSince: typeof entry.learningSince === 'string' ? entry.learningSince : undefined,
                knownSince: typeof entry.knownSince === 'string' ? entry.knownSince : undefined,
                updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
            });
        }
    }

    const migrated = migrateLegacyKnownKanji(settings);
    if (migrated > 0) {
        console.debug(`[${EXTENSION_NAME}] Migrated ${migrated} known kanji to unified state map`);
        persist();
    }

    loaded = true;
}

/**
 * Migrates a legacy `knownKanji` array/object into the unified state map.
 * Removes the legacy key after migration. Newer state entries already in the
 * map win — legacy entries are only added for chars not already tracked.
 * @param {object} settings
 * @returns {number} number of migrated entries
 */
function migrateLegacyKnownKanji(settings) {
    const legacy = settings.knownKanji;
    if (!legacy) return 0;

    let count = 0;
    const apply = (ch, dateOrNull) => {
        if (typeof ch !== 'string' || !ch) return;
        if (kanjiState.has(ch)) return; // newer entry wins
        const date = (typeof dateOrNull === 'string' && dateOrNull) ? dateOrNull : new Date().toISOString();
        kanjiState.set(ch, { state: 'known', knownSince: date, updatedAt: date });
        count++;
    };

    if (Array.isArray(legacy)) {
        for (const ch of legacy) apply(ch, null);
    } else if (typeof legacy === 'object') {
        for (const [ch, val] of Object.entries(legacy)) apply(ch, val);
    }

    delete settings.knownKanji;
    return count;
}

/**
 * Persists the current state map to extension settings.
 */
function persist() {
    extension_settings[EXTENSION_KEY] = extension_settings[EXTENSION_KEY] || {};
    const obj = {};
    for (const [ch, entry] of kanjiState) {
        // Only write defined fields to keep the object compact
        const out = { state: entry.state, updatedAt: entry.updatedAt };
        if (entry.learningSince) out.learningSince = entry.learningSince;
        if (entry.knownSince) out.knownSince = entry.knownSince;
        obj[ch] = out;
    }
    extension_settings[EXTENSION_KEY].kanjiState = obj;
    saveSettingsDebounced();
}

/**
 * Returns the current state for a kanji, defaulting to 'unknown'.
 * @param {string} char
 * @returns {KanjiStateName}
 */
export function getState(char) {
    return kanjiState.get(char)?.state || 'unknown';
}

/**
 * Returns the full state entry for a kanji, or null if unknown.
 * @param {string} char
 * @returns {KanjiStateEntry|null}
 */
export function getStateEntry(char) {
    return kanjiState.get(char) || null;
}

/**
 * @param {string} char
 * @returns {boolean}
 */
export function isKnown(char) {
    return getState(char) === 'known';
}

/**
 * @param {string} char
 * @returns {boolean}
 */
export function isLearning(char) {
    return getState(char) === 'learning';
}

/**
 * Sets a kanji's state. See module docstring for transition semantics.
 * @param {string} char
 * @param {KanjiStateName} newState
 * @returns {KanjiStateName} the new state after the operation
 */
export function setState(char, newState) {
    if (!char) return 'unknown';
    const now = new Date().toISOString();
    const current = kanjiState.get(char);

    if (newState === 'unknown') {
        if (current) {
            kanjiState.delete(char);
            persist();
        }
        return 'unknown';
    }

    if (newState === 'learning') {
        if (current?.state === 'learning') return 'learning';
        // Demote from known, or set fresh from unknown.
        // Preserve learningSince if it existed; otherwise stamp now.
        const entry = {
            state: 'learning',
            learningSince: current?.learningSince || now,
            updatedAt: now,
        };
        kanjiState.set(char, entry);
        persist();
        return 'learning';
    }

    if (newState === 'known') {
        if (current?.state === 'known') return 'known';
        // Promote from learning, or set fresh from unknown.
        // Preserve learningSince history; stamp knownSince if it isn't set yet.
        const entry = {
            state: 'known',
            knownSince: current?.knownSince || now,
            updatedAt: now,
        };
        if (current?.learningSince) entry.learningSince = current.learningSince;
        kanjiState.set(char, entry);
        persist();
        return 'known';
    }

    return getState(char);
}

/**
 * Cycles a kanji's state in the order: unknown → learning → known → unknown.
 * @param {string} char
 * @returns {KanjiStateName} the new state
 */
export function cycleState(char) {
    const next = /** @type {Record<KanjiStateName, KanjiStateName>} */ ({
        unknown: 'learning',
        learning: 'known',
        known: 'unknown',
    });
    return setState(char, next[getState(char)]);
}

/**
 * Convenience for binary "Mark Known" UI: toggles between known and unknown.
 * If the kanji is currently learning, it is promoted to known (not toggled off).
 * @param {string} char
 * @returns {boolean} true if now known
 */
export function toggleKnown(char) {
    if (isKnown(char)) {
        setState(char, 'unknown');
        return false;
    }
    setState(char, 'known');
    return true;
}

/**
 * Returns a Map<char, entry> of all kanji whose state is 'known'.
 * Returned map is a snapshot; do not mutate.
 * @returns {Map<string, KanjiStateEntry>}
 */
export function getKnownKanji() {
    const out = new Map();
    for (const [ch, entry] of kanjiState) {
        if (entry.state === 'known') out.set(ch, entry);
    }
    return out;
}

/**
 * Returns a Map<char, entry> of all kanji whose state is 'learning'.
 * @returns {Map<string, KanjiStateEntry>}
 */
export function getLearningKanji() {
    const out = new Map();
    for (const [ch, entry] of kanjiState) {
        if (entry.state === 'learning') out.set(ch, entry);
    }
    return out;
}

/**
 * @returns {string[]} characters currently marked as known
 */
export function getKnownChars() {
    const out = [];
    for (const [ch, entry] of kanjiState) {
        if (entry.state === 'known') out.push(ch);
    }
    return out;
}

/**
 * @returns {string[]} characters currently marked as learning
 */
export function getLearningChars() {
    const out = [];
    for (const [ch, entry] of kanjiState) {
        if (entry.state === 'learning') out.push(ch);
    }
    return out;
}

/**
 * Returns the underlying state map (live reference).
 * Read-only; do not mutate directly.
 * @returns {Map<string, KanjiStateEntry>}
 */
export function getAllStateEntries() {
    return kanjiState;
}

/**
 * @returns {boolean} true once `loadKanjiState()` has been called at least once
 */
export function isStateLoaded() {
    return loaded;
}
