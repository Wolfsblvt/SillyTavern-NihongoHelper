import { EXTENSION_NAME } from '../index.js';

/**
 * @typedef {Object} KanjiEntry
 * @property {string} k  - The kanji character
 * @property {number} i  - Sequential index
 * @property {number|null} s  - Stroke count
 * @property {number|null} g  - School grade (1-6, 8=junior high)
 * @property {number|null} f  - Newspaper frequency rank (1=most common)
 * @property {number|null} jlpt - JLPT level (1-5, 5=easiest)
 * @property {string[]} m  - English meanings
 * @property {string[]} on - On'yomi readings
 * @property {string[]} kun - Kun'yomi readings
 */

/** @type {KanjiEntry[]} */
let kanjiData = [];

/** @type {Map<string, KanjiEntry>} */
const kanjiMap = new Map();

let loaded = false;
let loading = false;

/**
 * Loads the kanji data from the JSON file.
 * @returns {Promise<void>}
 */
export async function loadKanjiData() {
    if (loaded || loading) return;
    loading = true;

    try {
        const url = `/scripts/extensions/third-party/${EXTENSION_NAME}/data/kanji.json`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        kanjiData = await response.json();

        kanjiMap.clear();
        for (const entry of kanjiData) {
            kanjiMap.set(entry.k, entry);
        }

        loaded = true;
        console.debug(`[${EXTENSION_NAME}] Loaded ${kanjiData.length} kanji entries`);
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Failed to load kanji data:`, err);
    } finally {
        loading = false;
    }
}

/**
 * Returns all loaded kanji entries.
 * @returns {KanjiEntry[]}
 */
export function getAllKanji() {
    return kanjiData;
}

/**
 * Looks up a single kanji by character.
 * @param {string} char
 * @returns {KanjiEntry|undefined}
 */
export function getKanji(char) {
    return kanjiMap.get(char);
}

/**
 * Returns whether kanji data has been loaded.
 * @returns {boolean}
 */
export function isKanjiDataLoaded() {
    return loaded;
}

/** Sort option definitions */
export const SORT_OPTIONS = {
    FREQ_ASC: 'freq_asc',
    FREQ_DESC: 'freq_desc',
    GRADE_ASC: 'grade_asc',
    JLPT_DESC: 'jlpt_easy',
    JLPT_ASC: 'jlpt_hard',
    STROKES_ASC: 'strokes_asc',
    STROKES_DESC: 'strokes_desc',
};

/** Filter option definitions */
export const FILTER_OPTIONS = {
    ALL: 'all',
    JLPT_N5: 'jlpt5',
    JLPT_N4: 'jlpt4',
    JLPT_N3: 'jlpt3',
    JLPT_N2: 'jlpt2',
    JLPT_N1: 'jlpt1',
    GRADE_1: 'grade1',
    GRADE_2: 'grade2',
    GRADE_3: 'grade3',
    GRADE_4: 'grade4',
    GRADE_5: 'grade5',
    GRADE_6: 'grade6',
    GRADE_JH: 'grade8',
    KNOWN: 'known',
    UNKNOWN: 'unknown',
};

/**
 * Filters and sorts kanji entries based on criteria.
 * @param {Object} options
 * @param {string} [options.filter='all']
 * @param {string} [options.sort='freq_asc']
 * @param {string} [options.search='']
 * @param {Set<string>} [options.knownKanji]
 * @returns {KanjiEntry[]}
 */
export function queryKanji({ filter = 'all', sort = 'freq_asc', search = '', knownKanji = new Set() } = {}) {
    let entries = [...kanjiData];

    // Apply text search (kanji char, meanings, readings)
    if (search.trim()) {
        const q = search.trim().toLowerCase();
        entries = entries.filter(e =>
            e.k === q
            || e.m.some(m => m.toLowerCase().includes(q))
            || e.on.some(r => r.includes(q))
            || e.kun.some(r => r.includes(q)),
        );
    }

    // Apply filter
    switch (filter) {
        case FILTER_OPTIONS.JLPT_N5: entries = entries.filter(e => e.jlpt === 5); break;
        case FILTER_OPTIONS.JLPT_N4: entries = entries.filter(e => e.jlpt === 4); break;
        case FILTER_OPTIONS.JLPT_N3: entries = entries.filter(e => e.jlpt === 3); break;
        case FILTER_OPTIONS.JLPT_N2: entries = entries.filter(e => e.jlpt === 2); break;
        case FILTER_OPTIONS.JLPT_N1: entries = entries.filter(e => e.jlpt === 1); break;
        case FILTER_OPTIONS.GRADE_1: entries = entries.filter(e => e.g === 1); break;
        case FILTER_OPTIONS.GRADE_2: entries = entries.filter(e => e.g === 2); break;
        case FILTER_OPTIONS.GRADE_3: entries = entries.filter(e => e.g === 3); break;
        case FILTER_OPTIONS.GRADE_4: entries = entries.filter(e => e.g === 4); break;
        case FILTER_OPTIONS.GRADE_5: entries = entries.filter(e => e.g === 5); break;
        case FILTER_OPTIONS.GRADE_6: entries = entries.filter(e => e.g === 6); break;
        case FILTER_OPTIONS.GRADE_JH: entries = entries.filter(e => e.g === 8); break;
        case FILTER_OPTIONS.KNOWN: entries = entries.filter(e => knownKanji.has(e.k)); break;
        case FILTER_OPTIONS.UNKNOWN: entries = entries.filter(e => !knownKanji.has(e.k)); break;
        default: break;
    }

    // Apply sort
    const nullHigh = 99999;
    switch (sort) {
        case SORT_OPTIONS.FREQ_ASC:
            entries.sort((a, b) => (a.f || nullHigh) - (b.f || nullHigh));
            break;
        case SORT_OPTIONS.FREQ_DESC:
            entries.sort((a, b) => (b.f || 0) - (a.f || 0));
            break;
        case SORT_OPTIONS.GRADE_ASC:
            entries.sort((a, b) => (a.g || nullHigh) - (b.g || nullHigh));
            break;
        case SORT_OPTIONS.JLPT_DESC:
            entries.sort((a, b) => (b.jlpt || 0) - (a.jlpt || 0));
            break;
        case SORT_OPTIONS.JLPT_ASC:
            entries.sort((a, b) => (a.jlpt || nullHigh) - (b.jlpt || nullHigh));
            break;
        case SORT_OPTIONS.STROKES_ASC:
            entries.sort((a, b) => (a.s || nullHigh) - (b.s || nullHigh));
            break;
        case SORT_OPTIONS.STROKES_DESC:
            entries.sort((a, b) => (b.s || 0) - (a.s || 0));
            break;
        default:
            break;
    }

    return entries;
}
