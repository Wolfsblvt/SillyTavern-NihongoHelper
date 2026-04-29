/**
 * Meaning provider abstraction layer.
 * Supports pluggable backends: JMdict (local), Jisho (network), LLM, etc.
 *
 * Provider interface (register via registerProvider):
 *   { name: string, load: () => Promise<void>, lookup: (word, reading) => result|null }
 *
 * Lookup result shape:
 *   { word, readings: string[], forms: string[],
 *     senses: [{ pos: string[], glosses: string[], misc: string[], info: string[], field: string[] }],
 *     source: string }
 */

import { loadJMdict, lookupWord, getTagDescription, isJMdictLoaded } from './jmdict.js';

// ── Provider registry ───────────────────────────────────────────────────────

/** @type {Map<string, { load: Function, lookup: Function }>} */
const providers = new Map();

/**
 * Registers a meaning provider.
 * @param {string} name
 * @param {{ load: () => Promise<void>, lookup: (word: string, reading?: string) => Object|null }} provider
 */
export function registerProvider(name, provider) {
    providers.set(name, provider);
}

// ── Built-in JMdict provider ────────────────────────────────────────────────

registerProvider('jmdict', {
    load: loadJMdict,
    lookup(word, reading) {
        const entry = lookupWord(word, reading);
        if (!entry) return null;
        return {
            word,
            readings: entry.r || [],
            forms: entry.k || [],
            senses: (entry.s || []).map(s => ({
                pos: (s.p || []).map(tag => getTagDescription(tag)),
                glosses: s.g || [],
                misc: (s.m || []).map(tag => getTagDescription(tag)),
                info: s.i || [],
                field: (s.f || []).map(tag => getTagDescription(tag)),
            })),
            source: 'jmdict',
        };
    },
});

// ── Public API ──────────────────────────────────────────────────────────────

let initialized = false;

/**
 * Initialize the default meaning provider(s). Call once during startup.
 * Loads JMdict in background — does not block.
 */
export async function initMeaningProvider() {
    if (initialized) return;
    initialized = true;
    // Load all registered providers in parallel (currently just JMdict)
    const loadPromises = [];
    for (const [, provider] of providers) {
        if (provider.load) loadPromises.push(provider.load());
    }
    await Promise.allSettled(loadPromises);
}

/**
 * Look up meanings for a word.
 * Tries the primary provider first, then falls back.
 * @param {string} word - Surface form
 * @param {string} [reading] - Reading hint from tokenizer
 * @returns {{ word: string, readings: string[], forms: string[], senses: Object[], source: string }|null}
 */
export function lookupMeaning(word, reading) {
    // TODO: respect settings for provider priority / overrides
    // For now, try JMdict
    const jmdict = providers.get('jmdict');
    if (jmdict) {
        const result = jmdict.lookup(word, reading);
        if (result) return result;
    }
    return null;
}

/**
 * Whether any meaning provider is loaded and ready.
 * @returns {boolean}
 */
export function isMeaningAvailable() {
    return isJMdictLoaded();
}
