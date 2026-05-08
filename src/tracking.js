import { getRequestHeaders } from '../../../../../script.js';
import { EXTENSION_NAME } from '../index.js';

/**
 * Word tracking module — sliding confidence model.
 *
 * Stores per-word familiarity data: confidence score (0–1), encounter counts,
 * timestamps, and user flags. Confidence is nudged by intuitive button clicks
 * (Easy/Got it/Meh/Hard) rather than setting absolute levels.
 *
 * Storage: kept in-memory, persisted via ST's files endpoint as a JSON file
 * (separate from extension_settings to avoid bloating settings saves).
 */

// ===== Constants =====

const STORAGE_FILENAME = 'nihongo-tracking.json';
const SAVE_INTERVAL_MS = 30_000; // debounced save every 30s
const STORAGE_VERSION = 1;

/** Nudge magnitudes for user actions */
export const NUDGE = Object.freeze({
    EASY: 0.20,
    GOT_IT: 0.10,
    MEH: -0.05,
    HARD: -0.15,
    SEEN: 0.01,       // passive encounter (diminishing)
    USED: 0.05,       // user wrote the word
    FIRST_SEEN: 0.05, // initial seed on first encounter
});

/** Derived level thresholds (confidence → level name) */
export const LEVEL_THRESHOLDS = Object.freeze({
    MASTERED: 0.85,
    KNOWN: 0.60,
    FAMILIAR: 0.30,
    SEEN: 0.10,
    // Below 0.10 = Unknown
});

// ===== Types =====

/**
 * @typedef {Object} WordEntry Full word tracking entry
 * @property {number} confidence  0.0–1.0 sliding confidence score
 * @property {number} seenCount   Times appeared in LLM output
 * @property {number} usedCount   Times user wrote it
 * @property {string} firstSeen   ISO timestamp
 * @property {string} lastSeen    ISO timestamp
 * @property {string|null} lastUsed     ISO timestamp or null
 * @property {string|null} lastInteraction  ISO timestamp of last button click
 * @property {string[]} flags     User-set flags: "anki-queued", "never-show"
 */

/**
 * @typedef {Object} CompactEntry Auto-tracked only (no interaction yet)
 * @property {number} s  seenCount
 * @property {string} l  lastSeen (date string YYYY-MM-DD)
 */

// ===== State =====

/** @type {Map<string, WordEntry | CompactEntry>} */
const store = new Map();

let dirty = false;
let loaded = false;
let loading = false;
/** @type {number|null} */
let saveTimer = null;
/** @type {string|null} - resolved URL path to the tracking file (returned by upload) */
let storagePath = null;

// ===== Public API =====

/**
 * Loads tracking data from the files endpoint. Call once on init.
 */
export async function loadTracking() {
    if (loaded || loading) return;
    loading = true;

    try {
        const filePath = `user/files/${STORAGE_FILENAME}`;

        // Check existence first via verify endpoint (avoids browser 404 console noise)
        const verifyRes = await fetch('/api/files/verify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ urls: [filePath] }),
        });

        if (!verifyRes.ok) {
            console.warn(`[${EXTENSION_NAME}] Tracking verify check failed`);
            return;
        }

        const verified = await verifyRes.json();
        if (!verified[filePath]) {
            console.debug(`[${EXTENSION_NAME}] No tracking file found, starting fresh`);
            return;
        }

        // File exists — fetch it
        const response = await fetch(`/${filePath}`, { cache: 'no-store' });
        if (response.ok) {
            const data = await response.json();
            if (data && data.v === STORAGE_VERSION && data.words) {
                for (const [word, entry] of Object.entries(data.words)) {
                    store.set(word, entry);
                }
                storagePath = filePath;
                console.debug(`[${EXTENSION_NAME}] Loaded tracking: ${store.size} words`);
            }
        } else {
            console.warn(`[${EXTENSION_NAME}] Tracking load failed: HTTP ${response.status}`);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Tracking load error:`, err);
    } finally {
        loaded = true;
        loading = false;
    }

    // Register unload handler for final save
    window.addEventListener('beforeunload', saveTrackingNow);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveTrackingNow();
    });
}

/**
 * Gets a word's tracking entry. Returns null if not tracked.
 * @param {string} word Dictionary form
 * @returns {WordEntry | CompactEntry | null}
 */
export function getWordEntry(word) {
    return store.get(word) || null;
}

/**
 * Gets the confidence score for a word. Returns 0 if not tracked.
 * @param {string} word Dictionary form
 * @returns {number}
 */
export function getConfidence(word) {
    const entry = store.get(word);
    if (!entry) return 0;
    if ('confidence' in entry) return entry.confidence;
    // Compact entry: estimate from seenCount
    return Math.min(0.05 + entry.s * 0.01 * (1 / (1 + entry.s / 20)), 0.3);
}

/**
 * Gets the derived level name for a word.
 * @param {string} word Dictionary form
 * @returns {'mastered'|'known'|'familiar'|'seen'|'unknown'}
 */
export function getDerivedLevel(word) {
    const c = getConfidence(word);
    if (c >= LEVEL_THRESHOLDS.MASTERED) return 'mastered';
    if (c >= LEVEL_THRESHOLDS.KNOWN) return 'known';
    if (c >= LEVEL_THRESHOLDS.FAMILIAR) return 'familiar';
    if (c >= LEVEL_THRESHOLDS.SEEN) return 'seen';
    return 'unknown';
}

/**
 * Records a passive encounter (word appeared in LLM output).
 * @param {string} word Dictionary form
 */
export function recordSeen(word) {
    const now = new Date().toISOString();
    const entry = store.get(word);

    if (!entry) {
        // First encounter — create compact entry
        store.set(word, { s: 1, l: now.slice(0, 10) });
        markDirty();
        return;
    }

    if ('confidence' in entry) {
        // Full entry
        entry.seenCount++;
        entry.lastSeen = now;
        // Diminishing confidence nudge from passive exposure
        const nudge = NUDGE.SEEN * (1 / (1 + entry.seenCount / 20));
        entry.confidence = clamp(entry.confidence + nudge);
    } else {
        // Compact entry
        entry.s++;
        entry.l = now.slice(0, 10);
    }

    markDirty();
}

/**
 * Records that the user wrote this word.
 * @param {string} word Dictionary form
 */
export function recordUsed(word) {
    const now = new Date().toISOString();
    const entry = ensureFullEntry(word);
    entry.usedCount++;
    entry.lastUsed = now;
    entry.confidence = clamp(entry.confidence + NUDGE.USED);
    markDirty();
}

/**
 * Applies a user confidence nudge (from tooltip button).
 * @param {string} word Dictionary form
 * @param {'easy'|'got_it'|'meh'|'hard'} action
 */
export function nudgeConfidence(word, action) {
    const entry = ensureFullEntry(word);
    const now = new Date().toISOString();
    entry.lastInteraction = now;

    const nudgeMap = {
        easy: NUDGE.EASY,
        got_it: NUDGE.GOT_IT,
        meh: NUDGE.MEH,
        hard: NUDGE.HARD,
    };

    const amount = nudgeMap[action] || 0;
    entry.confidence = clamp(entry.confidence + amount);
    markDirty();
}

/**
 * Toggles a flag on a word entry.
 * @param {string} word Dictionary form
 * @param {string} flag Flag name (e.g., "anki-queued", "never-show")
 * @param {boolean} [state] Force on/off. Omit to toggle.
 * @returns {boolean} New flag state
 */
export function toggleFlag(word, flag, state) {
    const entry = ensureFullEntry(word);
    const idx = entry.flags.indexOf(flag);
    const shouldHave = state !== undefined ? state : idx === -1;

    if (shouldHave && idx === -1) {
        entry.flags.push(flag);
    } else if (!shouldHave && idx !== -1) {
        entry.flags.splice(idx, 1);
    }

    markDirty();
    return shouldHave;
}

/**
 * Resets a word's confidence to 0 and clears all flags.
 * @param {string} word Dictionary form
 */
export function resetConfidence(word) {
    const entry = store.get(word);
    if (!entry) return;

    if ('confidence' in entry) {
        entry.confidence = 0;
        entry.lastInteraction = new Date().toISOString();
        entry.flags = [];
    } else {
        // Compact entry — just delete it entirely
        store.delete(word);
    }

    markDirty();
}

/**
 * Returns all tracked words above a given confidence threshold.
 * @param {number} minConfidence Minimum confidence score
 * @returns {Map<string, number>} word → confidence
 */
export function getWordsAbove(minConfidence) {
    const result = new Map();
    for (const [word] of store) {
        const c = getConfidence(word);
        if (c >= minConfidence) result.set(word, c);
    }
    return result;
}

/**
 * Returns total number of tracked words.
 * @returns {number}
 */
export function getTrackedCount() {
    return store.size;
}

// ===== Internal =====

/**
 * Ensures a word has a full entry (promotes compact → full if needed).
 * Creates a new full entry if word is untracked.
 * @param {string} word
 * @returns {WordEntry}
 */
function ensureFullEntry(word) {
    const existing = store.get(word);
    if (existing && 'confidence' in existing) return existing;

    const now = new Date().toISOString();

    /** @type {WordEntry} */
    const full = {
        confidence: existing
            ? Math.min(NUDGE.FIRST_SEEN + existing.s * 0.01 * (1 / (1 + existing.s / 20)), 0.3)
            : NUDGE.FIRST_SEEN,
        seenCount: existing ? existing.s : 0,
        usedCount: 0,
        firstSeen: existing ? existing.l + 'T00:00:00Z' : now,
        lastSeen: now,
        lastUsed: null,
        lastInteraction: null,
        flags: [],
    };

    store.set(word, full);
    return full;
}

/** Clamp value to [0, 1] */
function clamp(v) {
    return Math.max(0, Math.min(1, v));
}

/** Mark store as dirty (needs save) and schedule a debounced save. */
function markDirty() {
    dirty = true;
    scheduleSave();
}

/** Schedules a save after SAVE_INTERVAL_MS. Resets existing timer. */
function scheduleSave() {
    if (saveTimer !== null) return; // already scheduled
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveTrackingNow();
    }, SAVE_INTERVAL_MS);
}

/** Immediately persists tracking data to the files endpoint. */
function saveTrackingNow() {
    if (!dirty || !loaded) return;
    dirty = false;

    const data = {
        v: STORAGE_VERSION,
        savedAt: new Date().toISOString(),
        words: Object.fromEntries(store),
    };

    const json = JSON.stringify(data);
    const base64 = btoa(unescape(encodeURIComponent(json)));

    // Fire-and-forget upload
    fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: STORAGE_FILENAME, data: base64 }),
    }).then(res => {
        if (res.ok) {
            return res.json().then(d => { storagePath = d.path; });
        }
        console.warn(`[${EXTENSION_NAME}] Tracking save failed: HTTP ${res.status}`);
    }).catch(err => {
        console.warn(`[${EXTENSION_NAME}] Tracking save error:`, err);
        dirty = true; // retry next cycle
    });
}
