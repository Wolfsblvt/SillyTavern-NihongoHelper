import { Fuse } from '../../../../../lib.js';
import { getJMdictWords, getJMdictTags, isJMdictLoaded } from './jmdict.js';
import { isFrequencyAvailable, getCompositeFrequency } from './frequency.js';
import { EXTENSION_NAME } from '../index.js';

/**
 * Dictionary search module — Fuse.js fuzzy search over local JMdict data.
 *
 * Supports searching by:
 * - English glosses (partial, fuzzy)
 * - Kana reading (partial, fuzzy)
 * - Kanji form (exact prefix or fuzzy)
 *
 * Uses the same Fuse.js library that SillyTavern already bundles,
 * with settings tuned for dictionary search (partial match, multi-field).
 */

// ===== State =====

/** @type {import('fuse.js').default|null} */
let fuseIndex = null;
/** @type {object[]|null} */
let searchData = null;
let built = false;

// ===== Public API =====

/**
 * Builds the search index from loaded JMdict data.
 * Must be called after JMdict is loaded. Safe to call multiple times.
 * @returns {boolean} Whether index was built successfully
 */
export function buildSearchIndex() {
    if (built) return true;
    if (!isJMdictLoaded()) return false;

    const words = getJMdictWords();
    if (!words || words.length === 0) return false;

    // Transform JMdict entries into flat searchable objects
    searchData = words.map((entry, idx) => ({
        idx,
        // Kanji forms joined (for searching by kanji)
        kanji: entry.k ? entry.k.join(' ') : '',
        // Kana readings joined
        reading: entry.r.join(' '),
        // All English glosses joined across all senses
        gloss: entry.s.map(s => s.g.join(', ')).join('; '),
        // First kanji form or first reading (display word)
        word: (entry.k && entry.k[0]) || entry.r[0],
        // Whether it's a common entry
        common: !!entry.c,
        // Raw entry reference
        _entry: entry,
    }));

    // Build Fuse index with multi-field search
    fuseIndex = new Fuse(searchData, {
        keys: [
            { name: 'gloss', weight: 10 },
            { name: 'kanji', weight: 8 },
            { name: 'reading', weight: 8 },
        ],
        includeScore: true,
        ignoreLocation: true,
        threshold: 0.3,
        minMatchCharLength: 2,
        // Extended search enables features like exact match with '
        useExtendedSearch: true,
    });

    built = true;
    console.debug(`[${EXTENSION_NAME}] Search index built: ${searchData.length} entries`);
    return true;
}

/**
 * Searches the dictionary.
 *
 * @param {string} query Search term (English, kana, or kanji)
 * @param {object} [options]
 * @param {number} [options.limit=20] Maximum results
 * @param {boolean} [options.commonFirst=true] (deprecated, composite ranking used instead)
 * @returns {SearchResult[]}
 */
export function searchDictionary(query, options = {}) {
    const { limit = 20, commonFirst = true } = options;

    if (!query || query.trim().length < 1) return [];
    if (!fuseIndex) {
        if (!buildSearchIndex()) return [];
    }

    const trimmed = query.trim();

    // Determine search strategy based on input type
    let results;
    if (isKana(trimmed) || isKanji(trimmed)) {
        // Japanese input: search kanji/reading fields with tighter threshold
        results = fuseIndex.search(trimmed, { limit: limit * 2 });
    } else {
        // English/romaji input: search gloss field
        results = fuseIndex.search(trimmed, { limit: limit * 2 });
    }

    // Map to result format with composite ranking
    const hasFreq = isFrequencyAvailable();
    let mapped = results.map(r => {
        const word = r.item.word;
        const kanji = r.item._entry.k || [];
        const readings = r.item._entry.r;
        const fuseScore = r.score || 0;

        // Exact match: any kanji form or reading matches query exactly
        const isExact = kanji.includes(trimmed) || readings.includes(trimmed);

        // Frequency rank (lower = more common, null = unknown)
        const freqRank = hasFreq ? getCompositeFrequency(word) : null;
        // Normalize frequency to 0–1 (0 = top rank, 1 = rare/unknown)
        const freqNorm = freqRank ? Math.min(freqRank / 50000, 1) : 1;

        // Composite ranking score (lower = better):
        //   Base: fuse score (0–1)
        //   Exact match: override to 0
        //   Common: -0.15 bonus
        //   Frequency: blend in 20% of normalized freq
        let rank = isExact ? 0 : fuseScore;
        if (r.item.common) rank -= 0.15;
        rank += freqNorm * 0.2;
        rank = Math.max(0, rank);

        return {
            word,
            reading: readings[0],
            kanji,
            readings,
            senses: r.item._entry.s,
            common: r.item.common,
            score: fuseScore,
            rank,
            entry: r.item._entry,
        };
    });

    // Sort by composite rank
    mapped.sort((a, b) => a.rank - b.rank);

    return mapped.slice(0, limit);
}

/**
 * @typedef {Object} SearchResult
 * @property {string} word Primary display word
 * @property {string} reading Primary reading
 * @property {string[]} kanji All kanji forms
 * @property {string[]} readings All readings
 * @property {Object[]} senses Sense entries with { p, g, m?, i?, f? }
 * @property {boolean} common Whether entry is marked common
 * @property {number} score Fuse match score (0 = perfect, 1 = worst)
 * @property {number} rank Composite ranking score (lower = better)
 * @property {Object} entry Raw JMdict entry
 */

/**
 * Returns whether the search index is ready.
 * @returns {boolean}
 */
export function isSearchReady() {
    return built && fuseIndex !== null;
}

/**
 * Invalidates the search index (call if JMdict reloads).
 */
export function invalidateSearchIndex() {
    fuseIndex = null;
    searchData = null;
    built = false;
}

// ===== Internal Helpers =====

/** Check if string contains primarily kana */
function isKana(str) {
    return /^[\u3040-\u309F\u30A0-\u30FF\u3000-\u303Fー]+$/.test(str);
}

/** Check if string contains kanji */
function isKanji(str) {
    return /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(str);
}
