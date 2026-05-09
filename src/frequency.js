import { EXTENSION_NAME } from '../index.js';

/**
 * Word frequency module.
 *
 * Loads data/frequency.json (built by scripts/build-frequency.cjs) and provides
 * lookup functions for word frequency ranks across multiple lists.
 *
 * Architecture: supports N frequency lists. A composite score function with
 * configurable weights normalizes across lists for downstream features
 * (furigana visibility, difficulty assessment, badge display).
 */

// ===== State =====

/** @type {Object<string, { name: string, count: number }>} */
let lists = {};

/** @type {Object<string, Object<string, number>>} - word → { listKey: rank } */
let words = {};

let loaded = false;
let loading = false;
let totalWords = 0;

// ===== Public API =====

/**
 * Loads frequency data from data/frequency.json.
 * Call once on init. Non-blocking if data doesn't exist yet.
 */
export async function loadFrequencyData() {
    if (loaded || loading) return;
    loading = true;

    try {
        const url = `/scripts/extensions/third-party/${EXTENSION_NAME}/data/frequency.json`;
        const response = await fetch(url);
        if (!response.ok) {
            if (response.status === 404) {
                console.debug(`[${EXTENSION_NAME}] No frequency data found (run build-frequency.cjs to add)`);
            } else {
                console.warn(`[${EXTENSION_NAME}] Frequency data load failed: HTTP ${response.status}`);
            }
            return;
        }

        const data = await response.json();
        if (data && data.v === 1) {
            lists = data.lists || {};
            words = data.words || {};
            totalWords = Object.keys(words).length;
            console.debug(`[${EXTENSION_NAME}] Loaded frequency data: ${totalWords} words, lists: ${Object.keys(lists).join(', ')}`);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Frequency data load error:`, err);
    } finally {
        loaded = true;
        loading = false;
    }
}

/**
 * Returns whether frequency data is loaded and available.
 * @returns {boolean}
 */
export function isFrequencyAvailable() {
    return loaded && Object.keys(lists).length > 0;
}

/**
 * Gets the list of available frequency lists.
 * @returns {{ key: string, name: string, count: number }[]}
 */
export function getFrequencyLists() {
    return Object.entries(lists).map(([key, info]) => ({ key, ...info }));
}

/**
 * Gets all frequency ranks for a word across all lists.
 * @param {string} word Dictionary form
 * @returns {Object<string, number> | null} { listKey: rank } or null if not found
 */
export function getFrequencyRanks(word) {
    const entry = words[word];
    return entry || null;
}

/**
 * Gets the frequency rank for a word in a specific list.
 * @param {string} word Dictionary form
 * @param {string} listKey List key (e.g., "jpdb", "netflix")
 * @param {string} [reading] Kana reading fallback
 * @returns {number | null} Rank (lower = more common) or null
 */
export function getFrequencyRank(word, listKey, reading) {
    const entry = words[word] || (reading && words[reading]);
    if (!entry) return null;
    return entry[listKey] || null;
}

/**
 * Computes a composite frequency score for a word.
 * With one list, returns that list's rank directly.
 * With multiple lists, applies weights and returns a weighted average.
 *
 * Lower score = more common word.
 *
 * @param {string} word Dictionary form
 * @param {Object<string, number>|string} [weightsOrReading] Optional per-list weights object, or kana reading string
 * @param {string} [reading] Kana reading fallback (used when JPDB stores kana-only)
 * @returns {number | null} Composite rank or null if not found in any list
 */
export function getCompositeFrequency(word, weightsOrReading, reading) {
    // Flexible signature: second arg can be weights object or reading string
    let weights = null;
    if (typeof weightsOrReading === 'string') {
        reading = weightsOrReading;
    } else if (weightsOrReading && typeof weightsOrReading === 'object') {
        weights = weightsOrReading;
    }

    const entry = words[word] || (reading && words[reading]);
    if (!entry) return null;

    const listKeys = Object.keys(entry);
    if (listKeys.length === 0) return null;
    if (listKeys.length === 1) return entry[listKeys[0]];

    // Weighted average (default: equal weight)
    let totalWeight = 0;
    let weightedSum = 0;

    for (const key of listKeys) {
        const w = (weights && weights[key]) || 1;
        weightedSum += entry[key] * w;
        totalWeight += w;
    }

    return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
}

/**
 * Gets the frequency tier for display purposes.
 * @param {string} word Dictionary form
 * @param {string} [reading] Kana reading fallback
 * @returns {'top1k'|'top5k'|'top15k'|'common'|'rare'|null}
 */
export function getFrequencyTier(word, reading) {
    const score = getCompositeFrequency(word, reading);
    if (score === null) return null;
    if (score <= 1000) return 'top1k';
    if (score <= 5000) return 'top5k';
    if (score <= 15000) return 'top15k';
    if (score <= 30000) return 'common';
    return 'rare';
}

/**
 * Converts a frequency rank to a human-readable 0–100% commonness score.
 * Uses a sigmoid-like power curve that maps Zipf-distributed ranks to
 * intuitive percentages for language learners:
 *   rank ~300  → 95%  (extremely common)
 *   rank ~1000 → 90%  (very common)
 *   rank ~5000 → 70%  (fairly common)
 *   rank ~15000 → 50% (moderate — roughly N1 boundary)
 *   rank ~50000 → 28%  (uncommon)
 *   rank ~200000 → 11% (rare)
 *
 * Formula: 100 / (1 + (rank / midpoint)^steepness)
 * Midpoint = 15000 (50% mark), steepness = 0.8.
 *
 * @param {string} word Dictionary form
 * @param {string} [reading] Kana reading fallback
 * @returns {number|null} Percentage (0–100) or null if not found
 */
export function getFrequencyPercent(word, reading) {
    const rank = getCompositeFrequency(word, reading);
    if (rank === null) return null;

    const MIDPOINT = 15000;
    const STEEPNESS = 0.8;
    const pct = 100 / (1 + Math.pow(rank / MIDPOINT, STEEPNESS));
    return Math.round(pct);
}
