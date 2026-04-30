/**
 * Multi-token matching engine.
 *
 * Given an array of kuromoji tokens, builds a match map by trying:
 *   1. Sliding window of 1..windowSize tokens — direct JMdict lookup
 *   2. If no direct match, try deinflection on each window
 *
 * Then applies greedy longest-match with one-round overlap extension
 * to produce non-overlapping spans for DOM rendering, attaching all
 * relevant interpretations (tooltip pages) to each span.
 *
 * @typedef {{ word: string, reading: string, source: 'direct'|'deinflect', rule?: string, baseWord?: string, matchedForms?: string[] }} MatchEntry
 * @typedef {{ start: number, end: number, surface: string, reading: string, matches: MatchEntry[] }} SpanInfo
 */

import { lookupMeaning, isMeaningAvailable } from './meaning-provider.js';
import { deinflect } from './deinflect.js';
import { nihongoSettings } from './settings.js';

/**
 * Converts katakana string to hiragana.
 * @param {string} str
 * @returns {string}
 */
function katakanaToHiragana(str) {
    return str.replace(/[\u30A1-\u30F6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/**
 * Checks if a character is kanji.
 * @param {string} ch
 * @returns {boolean}
 */
function isKanji(ch) {
    const code = ch.charCodeAt(0);
    return (code >= 0x4E00 && code <= 0x9FAF) || (code >= 0x3400 && code <= 0x4DBF);
}

/**
 * Checks if a string contains any kanji.
 * @param {string} str
 * @returns {boolean}
 */
function containsKanji(str) {
    for (const ch of str) {
        if (isKanji(ch)) return true;
    }
    return false;
}

/**
 * Builds a raw match map from token array using sliding window.
 * Key: "start:end" (token indices, end exclusive)
 * Value: array of MatchEntry
 *
 * @param {Array<{ surface_form: string, reading?: string, pos?: string }>} tokens
 * @param {number} windowSize
 * @returns {Map<string, MatchEntry[]>}
 */
function buildMatchMap(tokens, windowSize) {
    /** @type {Map<string, MatchEntry[]>} */
    const matchMap = new Map();
    if (!isMeaningAvailable()) return matchMap;

    for (let i = 0; i < tokens.length; i++) {
        for (let len = 1; len <= Math.min(windowSize, tokens.length - i); len++) {
            const slice = tokens.slice(i, i + len);
            const surface = slice.map(t => t.surface_form).join('');

            // Skip windows whose surface contains whitespace — LLMs insert spaces
            // between Japanese words, and joining across them creates false matches
            // via the reading fallback in lookupWord.
            if (/\s/.test(surface)) continue;

            const reading = slice.map(t => t.reading ? katakanaToHiragana(t.reading) : '').join('');

            const key = `${i}:${i + len}`;
            const entries = [];

            // Direct lookup
            const meaning = lookupMeaning(surface, reading);
            if (meaning) {
                entries.push({ word: surface, reading, source: 'direct', matchedForms: meaning.forms || [] });
            }

            // Also try katakana→hiragana variant
            const asHiragana = katakanaToHiragana(surface);
            if (!meaning && asHiragana !== surface) {
                const hMeaning = lookupMeaning(asHiragana);
                if (hMeaning) {
                    entries.push({ word: asHiragana, reading, source: 'direct', matchedForms: hMeaning.forms || [] });
                }
            }

            // Deinflection
            const candidates = deinflect(surface);
            for (const candidate of candidates) {
                const dMeaning = lookupMeaning(candidate.word);
                if (dMeaning) {
                    entries.push({
                        word: surface,
                        reading,
                        source: 'deinflect',
                        rule: candidate.rule,
                        baseWord: candidate.word,
                        matchedForms: dMeaning.forms || [],
                    });
                    break; // take first deinflection hit
                }
            }

            if (entries.length > 0) {
                matchMap.set(key, entries);
            }
        }
    }

    return matchMap;
}

/**
 * Applies greedy longest-match with one-round overlap extension.
 * Returns an array of SpanInfo objects covering all tokens.
 *
 * @param {Array<{ surface_form: string, reading?: string, pos?: string }>} tokens
 * @param {Map<string, MatchEntry[]>} matchMap
 * @returns {SpanInfo[]}
 */
function greedySpans(tokens, matchMap) {
    const spans = [];
    let pos = 0;

    while (pos < tokens.length) {
        // Find longest match starting at pos
        let bestEnd = pos + 1;
        let bestMatches = [];

        for (let len = Math.min(nihongoSettings.lookupWindowSize, tokens.length - pos); len >= 1; len--) {
            const key = `${pos}:${pos + len}`;
            const entries = matchMap.get(key);
            if (entries && entries.length > 0) {
                bestEnd = pos + len;
                bestMatches = [...entries];
                break; // longest first
            }
        }

        // One-round overlap extension: check if any match extends beyond bestEnd
        // by starting within pos..bestEnd
        let extended = false;
        for (let start = pos + 1; start < bestEnd; start++) {
            for (let len = 2; len <= Math.min(nihongoSettings.lookupWindowSize, tokens.length - start); len++) {
                const end = start + len;
                if (end <= bestEnd) continue; // doesn't extend
                const key = `${start}:${end}`;
                const entries = matchMap.get(key);
                if (entries && entries.length > 0) {
                    // Extend span and add these matches
                    bestEnd = end;
                    bestMatches.push(...entries);
                    extended = true;
                    break; // one extension per starting point
                }
            }
            if (extended) break; // one round only
        }

        // Also collect sub-matches (shorter spans within pos..bestEnd)
        if (bestMatches.length > 0) {
            for (let s = pos; s < bestEnd; s++) {
                for (let len = 1; len <= bestEnd - s; len++) {
                    if (s === pos && s + len === bestEnd) continue; // skip self
                    const key = `${s}:${s + len}`;
                    const entries = matchMap.get(key);
                    if (entries) {
                        for (const entry of entries) {
                            // Avoid duplicates
                            if (!bestMatches.some(m => m.word === entry.word && m.source === entry.source && m.rule === entry.rule)) {
                                bestMatches.push(entry);
                            }
                        }
                    }
                }
            }
        }

        const slice = tokens.slice(pos, bestEnd);
        const surface = slice.map(t => t.surface_form).join('');
        const reading = slice.map(t => t.reading ? katakanaToHiragana(t.reading) : '').join('');

        spans.push({
            start: pos,
            end: bestEnd,
            surface,
            reading,
            matches: bestMatches,
        });

        pos = bestEnd;
    }

    return spans;
}

/**
 * Checks whether a match is an "exact writing" — the looked-up word appears
 * as one of the JMdict kanji forms, OR the entry has no kanji forms (kana-only).
 * Alternative writings (matched only via reading) rank lower.
 * @param {MatchEntry} m
 * @returns {boolean}
 */
function isExactWriting(m) {
    const forms = m.matchedForms;
    if (!forms || forms.length === 0) return true; // kana-only entry = always exact
    const lookupWord = m.source === 'deinflect' ? (m.baseWord || m.word) : m.word;
    return forms.includes(lookupWord);
}

/**
 * Sort matches for tooltip display order:
 * 1. Exact writing matches first (lookup word is a kanji form in JMdict)
 * 2. Longest surface form (inflected word, not base)
 * 3. Deinflected before direct at same length
 * 4. Original order preserved otherwise (stable sort)
 * @param {MatchEntry[]} matches
 * @returns {MatchEntry[]}
 */
function sortMatches(matches) {
    const indexed = matches.map((m, i) => ({ m, i }));
    indexed.sort((a, b) => {
        // Exact writing before alternative writing
        const aExact = isExactWriting(a.m) ? 0 : 1;
        const bExact = isExactWriting(b.m) ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        // Longest surface first
        const lenDiff = b.m.word.length - a.m.word.length;
        if (lenDiff !== 0) return lenDiff;
        // Deinflected before direct at same length
        if (a.m.source !== b.m.source) return a.m.source === 'deinflect' ? -1 : 1;
        // Preserve original order
        return a.i - b.i;
    });
    return indexed.map(x => x.m);
}

// ── Match storage (JS-side, keyed by span ID) ──────────────────────────────

let spanIdCounter = 0;
/** @type {Map<string, MatchEntry[]>} spanId → sorted matches */
const spanMatchStore = new Map();

/**
 * Stores matches for a span and returns the span ID.
 * @param {MatchEntry[]} matches
 * @returns {string}
 */
function storeMatches(matches) {
    const id = `nm_${++spanIdCounter}`;
    spanMatchStore.set(id, sortMatches(matches));
    return id;
}

/**
 * Retrieves stored matches for a span ID.
 * @param {string} id
 * @returns {MatchEntry[]|null}
 */
export function getStoredMatches(id) {
    return spanMatchStore.get(id) || null;
}

/**
 * Clears all stored matches (call on chat change / full re-process).
 */
export function clearMatchStore() {
    spanMatchStore.clear();
    spanIdCounter = 0;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Analyzes tokens and returns greedy span info with all match data.
 * Each span has a storeId for the tooltip system to retrieve matches.
 *
 * @param {Array<{ surface_form: string, reading?: string, pos?: string }>} tokens
 * @returns {SpanInfo[]}
 */
export function analyzeTokens(tokens) {
    const windowSize = nihongoSettings.lookupWindowSize;
    if (windowSize < 2 && !isMeaningAvailable()) {
        // No multi-token and no dict — return simple spans
        return tokens.map((t, i) => ({
            start: i,
            end: i + 1,
            surface: t.surface_form,
            reading: t.reading ? katakanaToHiragana(t.reading) : '',
            matches: [],
        }));
    }

    const matchMap = buildMatchMap(tokens, windowSize);
    return greedySpans(tokens, matchMap);
}

/**
 * Stores matches for a span and returns the data-match-id attribute value.
 * Only stores if there are matches to store.
 * @param {MatchEntry[]} matches
 * @returns {string|null} The span ID, or null if no matches
 */
export function registerSpanMatches(matches) {
    if (!matches || matches.length === 0) return null;
    return storeMatches(matches);
}
