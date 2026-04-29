/**
 * JMdict local dictionary provider.
 * Loads data/jmdict.json and provides synchronous word lookup.
 */

const EXTENSION_PATH = 'scripts/extensions/third-party/SillyTavern-NihongoHelper';

/** @type {Object|null} */
let jmdata = null;
/** @type {Map<string, number>|null} */
let index = null;
let loaded = false;
let loading = false;

/**
 * Loads the JMdict data file and builds the lookup index.
 * Safe to call multiple times (no-op after first load).
 */
export async function loadJMdict() {
    if (loaded || loading) return;
    loading = true;
    try {
        const resp = await fetch(`/${EXTENSION_PATH}/data/jmdict.json`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        jmdata = await resp.json();
        buildIndex();
        loaded = true;
        console.log(`[NihongoHelper] JMdict loaded: ${jmdata.words.length} entries, ${index.size} index keys`);
    } catch (err) {
        console.warn(`[NihongoHelper] Failed to load JMdict:`, err);
    } finally {
        loading = false;
    }
}

/**
 * Builds a Map from every kanji/kana form → entry index.
 */
function buildIndex() {
    index = new Map();
    for (let i = 0; i < jmdata.words.length; i++) {
        const entry = jmdata.words[i];
        if (entry.k) {
            for (const k of entry.k) {
                if (!index.has(k)) index.set(k, i);
            }
        }
        for (const r of entry.r) {
            if (!index.has(r)) index.set(r, i);
        }
    }
}

/**
 * Looks up a word in the dictionary.
 * @param {string} word - Surface form (kanji or kana)
 * @param {string} [reading] - Reading hint from tokenizer
 * @returns {Object|null} Raw entry { k?, r, s: [{ p, g, m?, i?, f? }] }
 */
export function lookupWord(word, reading) {
    if (!loaded || !index) return null;

    // Try exact match on surface form first
    let idx = index.get(word);

    // Fallback: try reading
    if (idx === undefined && reading) {
        idx = index.get(reading);
    }

    if (idx === undefined) return null;
    return jmdata.words[idx];
}

/**
 * Resolves a JMdict tag code to its full description.
 * @param {string} tag
 * @returns {string}
 */
export function getTagDescription(tag) {
    if (!jmdata || !jmdata.tags) return tag;
    return jmdata.tags[tag] || tag;
}

/**
 * @returns {boolean}
 */
export function isJMdictLoaded() {
    return loaded;
}
