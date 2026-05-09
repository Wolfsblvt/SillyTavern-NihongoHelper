import { Fuse } from '../../../../../lib.js';
import { getJMdictWords, getJMdictTags, isJMdictLoaded, lookupAllWords } from './jmdict.js';
import { isFrequencyAvailable, getCompositeFrequency } from './frequency.js';
import { deinflect } from './deinflect.js';
import { romajiToHiragana, isRomaji } from './romaji.js';
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
 * Strategy (in priority order):
 * 1. Direct index lookup — exact matches always first (rank 0)
 * 2. Deinflection — inflected query → dictionary forms (rank 0.02, with inflection metadata)
 * 3. Fuse fuzzy search — English glosses, readings, kanji forms (composite rank)
 *
 * Results are deduplicated by entry identity and sorted by composite rank.
 *
 * @param {string} query Search term (English, kana, or kanji)
 * @param {object} [options]
 * @param {number} [options.limit=20] Maximum results
 * @returns {SearchResult[]}
 */
export function searchDictionary(query, options = {}) {
    const { limit = 20 } = options;

    if (!query || query.trim().length < 1) return [];
    if (!fuseIndex) {
        if (!buildSearchIndex()) return [];
    }

    const trimmed = query.trim();
    const hasFreq = isFrequencyAvailable();

    // Romaji detection & conversion: "ireru" → "いれる", enables Japanese lookup phases
    let kanaQuery = null;
    if (isRomaji(trimmed)) {
        kanaQuery = romajiToHiragana(trimmed);
    }

    const isJapanese = isKana(trimmed) || isKanji(trimmed);
    // Effective Japanese query: either the original (if already Japanese) or romaji-converted kana
    const jpQuery = isJapanese ? trimmed : kanaQuery;

    /** @type {Map<object, SearchResult>} entry ref → result (dedup) */
    const resultMap = new Map();

    // --- Phase 1: Direct index lookup (exact matches) ---
    if (jpQuery) {
        const directEntries = lookupAllWords(jpQuery);
        for (const entry of directEntries) {
            if (resultMap.has(entry)) continue;
            const word = (entry.k && entry.k[0]) || entry.r[0];
            const readings = entry.r;
            // Rank: 0 for exact word match, tiny penalty for entries where query matches a secondary form
            const isPrimaryForm = word === jpQuery || readings[0] === jpQuery;
            const rank = isPrimaryForm ? 0 : 0.001;
            resultMap.set(entry, {
                word,
                reading: readings[0],
                kanji: entry.k || [],
                readings,
                senses: entry.s,
                common: !!entry.c,
                score: 0,
                rank,
                entry,
            });
        }
    }

    // --- Phase 1b: Direct English gloss matching (substring scan) ---
    if (!isJapanese) {
        // For English queries, scan all entries for individual gloss matches
        // This avoids Fuse penalizing entries with many glosses (long concatenated string)
        const lowerQuery = trimmed.toLowerCase();
        const words = getJMdictWords();
        if (words) {
            /** @type {{entry: object, matchQuality: number}[]} */
            const glossMatches = [];
            for (const entry of words) {
                let bestQuality = Infinity;
                for (const sense of entry.s) {
                    for (const gloss of sense.g) {
                        const lowerGloss = gloss.toLowerCase();
                        if (lowerGloss === lowerQuery) {
                            // Exact gloss match
                            bestQuality = Math.min(bestQuality, 0);
                        } else if (lowerGloss.startsWith(lowerQuery)) {
                            // Gloss starts with query (e.g. "put in" matches "put in place")
                            bestQuality = Math.min(bestQuality, 0.005);
                        } else if (lowerGloss.includes(lowerQuery)) {
                            // Query is a substring (e.g. "put in" in "to put in")
                            bestQuality = Math.min(bestQuality, 0.01);
                        }
                    }
                }
                if (bestQuality < Infinity) {
                    glossMatches.push({ entry, matchQuality: bestQuality });
                }
            }

            // Sort by match quality, then common, then frequency — take top candidates
            glossMatches.sort((a, b) => {
                if (a.matchQuality !== b.matchQuality) return a.matchQuality - b.matchQuality;
                const aCommon = !!a.entry.c;
                const bCommon = !!b.entry.c;
                if (aCommon !== bCommon) return aCommon ? -1 : 1;
                const aFreq = hasFreq ? (getCompositeFrequency(
                    (a.entry.k && a.entry.k[0]) || a.entry.r[0], a.entry.r[0],
                ) || 999999) : 999999;
                const bFreq = hasFreq ? (getCompositeFrequency(
                    (b.entry.k && b.entry.k[0]) || b.entry.r[0], b.entry.r[0],
                ) || 999999) : 999999;
                return aFreq - bFreq;
            });

            for (const { entry, matchQuality } of glossMatches.slice(0, limit * 2)) {
                if (resultMap.has(entry)) continue;
                const word = (entry.k && entry.k[0]) || entry.r[0];
                const readings = entry.r;
                resultMap.set(entry, {
                    word,
                    reading: readings[0],
                    kanji: entry.k || [],
                    readings,
                    senses: entry.s,
                    common: !!entry.c,
                    score: 0,
                    rank: matchQuality,
                    entry,
                });
            }
        }
    }

    // --- Phase 2: Deinflection (inflected Japanese input → dictionary forms) ---
    if (jpQuery) {
        const candidates = deinflect(jpQuery);
        for (const candidate of candidates) {
            const entries = lookupAllWords(candidate.word);
            for (const entry of entries) {
                if (resultMap.has(entry)) continue;
                const word = (entry.k && entry.k[0]) || entry.r[0];
                const readings = entry.r;
                resultMap.set(entry, {
                    word,
                    reading: readings[0],
                    kanji: entry.k || [],
                    readings,
                    senses: entry.s,
                    common: !!entry.c,
                    score: 0,
                    rank: 0.02,
                    entry,
                    inflection: candidate.rule,
                    inflectedForm: jpQuery,
                });
            }
        }
    }

    // --- Phase 3: Fuse fuzzy search ---
    // Search with both original query and kana conversion (if different)
    const fuseQueries = [trimmed];
    if (kanaQuery && kanaQuery !== trimmed) fuseQueries.push(kanaQuery);

    for (const fq of fuseQueries) {
        const fuseResults = fuseIndex.search(fq, { limit: limit * 3 });

        for (const r of fuseResults) {
            const entry = r.item._entry;
            if (resultMap.has(entry)) continue; // Already added via direct/deinflect

            const word = r.item.word;
            const kanji = entry.k || [];
            const readings = entry.r;
            const fuseScore = r.score || 0;
            const allForms = [...kanji, ...readings];

            // Exact match check (safety: should have been caught in Phase 1)
            const isExact = allForms.includes(trimmed) || (kanaQuery && allForms.includes(kanaQuery));

            // Prefix overlap for partial matches
            const prefixScore = bestPrefixOverlap(jpQuery || trimmed, allForms);

            // Frequency normalization
            const freqRank = hasFreq ? getCompositeFrequency(word, readings[0]) : null;
            const freqNorm = freqRank ? Math.min(freqRank / 50000, 1) : 1;

            // Composite ranking (lower = better)
            let rank;
            if (isExact) {
                rank = 0;
            } else if (prefixScore >= 0.5) {
                rank = 0.05 + (1 - prefixScore) * 0.35;
            } else {
                rank = 0.4 + fuseScore * 0.6;
            }

            if (r.item.common) rank -= 0.05;
            rank += freqNorm * 0.1;
            rank = Math.max(0, rank);

            resultMap.set(entry, {
                word,
                reading: readings[0],
                kanji,
                readings,
                senses: entry.s,
                common: r.item.common,
                score: fuseScore,
                rank,
                entry,
            });
        }
    }

    // Sort by composite rank, then by frequency for ties
    const results = [...resultMap.values()];
    results.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        // Tie-break: common first, then by frequency
        if (a.common !== b.common) return a.common ? -1 : 1;
        const aFreq = hasFreq ? (getCompositeFrequency(a.word, a.reading) || 999999) : 999999;
        const bFreq = hasFreq ? (getCompositeFrequency(b.word, b.reading) || 999999) : 999999;
        return aFreq - bFreq;
    });

    return results.slice(0, limit);
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
 * @property {string} [inflection] Inflection rule name (if found via deinflection)
 * @property {string} [inflectedForm] Original inflected form that was searched
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

/**
 * Computes best prefix overlap between a query and a list of word forms.
 * Returns 0–1 (1 = one form is a perfect prefix of the other).
 *
 * Uses min(query, form) as denominator so inflected lookups score well:
 *   入れます vs 入れる: share 入れ → 2/min(4,3) = 0.67
 *   入れます vs 仕入れる: share nothing → 0
 *
 * Applies a length-ratio penalty so compound words (仕入れる, 4 chars)
 * don't outscore shorter dictionary forms (入れる, 3 chars).
 *
 * @param {string} query
 * @param {string[]} forms All kanji + reading forms of the entry
 * @returns {number}
 */
function bestPrefixOverlap(query, forms) {
    let best = 0;
    for (const form of forms) {
        // Count shared prefix characters
        let match = 0;
        const maxLen = Math.min(query.length, form.length);
        for (let i = 0; i < maxLen; i++) {
            if (query[i] === form[i]) match++;
            else break;
        }
        if (match === 0) continue;

        // Base ratio: shared prefix / shorter string
        const baseScore = match / Math.min(query.length, form.length);

        // Length penalty: prefer forms close in length to the query
        // ratio = 1.0 when equal length, lower when form is much longer
        const lenRatio = Math.min(query.length, form.length) / Math.max(query.length, form.length);
        const score = baseScore * (0.7 + 0.3 * lenRatio);

        if (score > best) best = score;
    }
    return best;
}
