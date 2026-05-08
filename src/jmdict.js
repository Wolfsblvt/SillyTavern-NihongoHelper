/**
 * JMdict local dictionary provider.
 * Loads data/jmdict.json and provides synchronous word lookup.
 */

const EXTENSION_PATH = 'scripts/extensions/third-party/SillyTavern-NihongoHelper';

/** @type {Object|null} */
let jmdata = null;
/** @type {Map<string, number[]>|null} */
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
 * Builds a Map from every kanji/kana form → array of entry indices.
 * Common entries are sorted first within each key's array.
 */
function buildIndex() {
    index = new Map();
    for (let i = 0; i < jmdata.words.length; i++) {
        const entry = jmdata.words[i];
        if (entry.k) {
            for (const k of entry.k) {
                let arr = index.get(k);
                if (!arr) { arr = []; index.set(k, arr); }
                arr.push(i);
            }
        }
        for (const r of entry.r) {
            let arr = index.get(r);
            if (!arr) { arr = []; index.set(r, arr); }
            arr.push(i);
        }
    }
    // Sort each key's entries: common first
    for (const [, arr] of index) {
        if (arr.length > 1) {
            arr.sort((a, b) => {
                const ac = jmdata.words[a].c ? 0 : 1;
                const bc = jmdata.words[b].c ? 0 : 1;
                return ac - bc;
            });
        }
    }
}

/**
 * Looks up the first matching word in the dictionary.
 * @param {string} word - Surface form (kanji or kana)
 * @param {string} [reading] - Reading hint from tokenizer
 * @returns {Object|null} Raw entry { k?, r, s: [{ p, g, m?, i?, f? }], c? }
 */
export function lookupWord(word, reading) {
    if (!loaded || !index) return null;

    let arr = index.get(word);
    if (!arr && reading) arr = index.get(reading);
    if (!arr || arr.length === 0) return null;
    return jmdata.words[arr[0]];
}

/**
 * Looks up ALL matching entries for a word in the dictionary.
 * @param {string} word - Surface form (kanji or kana)
 * @param {string} [reading] - Reading hint from tokenizer
 * @returns {Object[]} Array of raw entries (may be empty)
 */
export function lookupAllWords(word, reading) {
    if (!loaded || !index) return [];

    let arr = index.get(word);
    if (!arr && reading) arr = index.get(reading);
    if (!arr) return [];
    return arr.map(i => jmdata.words[i]);
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

/**
 * Returns the raw words array for use by search/indexing modules.
 * @returns {Object[]|null}
 */
export function getJMdictWords() {
    return jmdata ? jmdata.words : null;
}

/**
 * Returns the tags dictionary for resolving tag codes.
 * @returns {Object|null}
 */
export function getJMdictTags() {
    return jmdata ? jmdata.tags : null;
}
