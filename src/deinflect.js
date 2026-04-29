/**
 * Japanese de-inflection module.
 * Given an inflected word, produces candidate dictionary forms.
 * The caller must verify candidates against a dictionary.
 *
 * @typedef {{ word: string, rule: string }} DeinflectCandidate
 */

// Godan i-row → u-row (masu-stem to dictionary form)
const GODAN_I = [
    ['い', 'う'], ['き', 'く'], ['ぎ', 'ぐ'], ['し', 'す'],
    ['ち', 'つ'], ['に', 'ぬ'], ['び', 'ぶ'], ['み', 'む'], ['り', 'る'],
];

// Godan a-row → u-row (negative stem to dictionary form)
const GODAN_A = [
    ['わ', 'う'], ['か', 'く'], ['が', 'ぐ'], ['さ', 'す'],
    ['た', 'つ'], ['な', 'ぬ'], ['ば', 'ぶ'], ['ま', 'む'], ['ら', 'る'],
];

// Godan e-row → u-row (potential/conditional/imperative)
const GODAN_E = [
    ['え', 'う'], ['け', 'く'], ['げ', 'ぐ'], ['せ', 'す'],
    ['て', 'つ'], ['ね', 'ぬ'], ['べ', 'ぶ'], ['め', 'む'], ['れ', 'る'],
];

// Te/ta onbin (sound changes) → dictionary ending
const GODAN_ONBIN = [
    ['いて', 'く'], ['いで', 'ぐ'], ['して', 'す'],
    ['って', 'つ'], ['って', 'る'], ['って', 'う'], ['って', 'く'],
    ['んで', 'ぬ'], ['んで', 'ぶ'], ['んで', 'む'],
];

// Same for ta-form
const GODAN_ONBIN_TA = GODAN_ONBIN.map(([te, u]) => [te.replace('て', 'た').replace('で', 'だ'), u]);

/**
 * Attempts to strip `from` suffix and append `to`, pushing result into candidates.
 * Requires at least 1 character of stem remaining.
 */
function tryRule(word, from, to, name, candidates) {
    if (!word.endsWith(from)) return;
    const stem = word.slice(0, -from.length);
    if (stem.length < 1) return;
    candidates.push({ word: stem + to, rule: name });
}

/**
 * Handles irregular verbs する and くる.
 */
function addIrregular(word, candidates) {
    // する compound verbs (e.g. 勉強します → 勉強する)
    const suru = [
        ['します', 'masu-form'], ['しません', 'negative polite'], ['しました', 'past polite'],
        ['して', 'te-form'], ['した', 'past tense'], ['しない', 'negative'],
        ['しろ', 'imperative'], ['しよう', 'volitional'], ['すれば', 'conditional'],
        ['される', 'passive'], ['させる', 'causative'], ['できる', 'potential'],
        ['している', 'progressive'], ['してる', 'progressive'],
        ['したい', 'tai-form'], ['しなかった', 'negative past'],
    ];
    for (const [suffix, name] of suru) {
        if (word.endsWith(suffix)) {
            const stem = word.slice(0, -suffix.length);
            if (stem.length >= 1) {
                candidates.push({ word: stem + 'する', rule: name });
            } else {
                candidates.push({ word: 'する', rule: name });
            }
        }
    }

    // くる (来る)
    const kuru = [
        ['きます', 'masu-form'], ['きません', 'negative polite'], ['きました', 'past polite'],
        ['きて', 'te-form'], ['きた', 'past tense'], ['こない', 'negative'],
        ['こい', 'imperative'], ['こよう', 'volitional'], ['くれば', 'conditional'],
        ['こられる', 'passive/potential'], ['こさせる', 'causative'],
        ['きている', 'progressive'], ['きてる', 'progressive'],
        ['きたい', 'tai-form'], ['こなかった', 'negative past'],
    ];
    for (const [suffix, name] of kuru) {
        if (word === suffix) {
            candidates.push({ word: 'くる', rule: name });
        }
    }
}

/**
 * Generates deinflection candidates for a given word.
 * Returns possible dictionary forms. Caller must verify with dictionary lookup.
 * @param {string} word - The inflected word (hiragana/katakana/mixed)
 * @returns {DeinflectCandidate[]}
 */
export function deinflect(word) {
    if (!word || word.length < 2) return [];
    const candidates = [];

    // --- Irregular verbs ---
    addIrregular(word, candidates);

    // --- Masu-form (polite) ---
    tryRule(word, 'ます', 'る', 'masu-form', candidates);
    for (const [i, u] of GODAN_I) {
        tryRule(word, i + 'ます', u, 'masu-form', candidates);
    }

    // --- Masen (negative polite) ---
    tryRule(word, 'ません', 'る', 'negative polite', candidates);
    for (const [i, u] of GODAN_I) {
        tryRule(word, i + 'ません', u, 'negative polite', candidates);
    }

    // --- Mashita (past polite) ---
    tryRule(word, 'ました', 'る', 'past polite', candidates);
    for (const [i, u] of GODAN_I) {
        tryRule(word, i + 'ました', u, 'past polite', candidates);
    }

    // --- Te-form ---
    tryRule(word, 'て', 'る', 'te-form', candidates);
    for (const [te, u] of GODAN_ONBIN) {
        tryRule(word, te, u, 'te-form', candidates);
    }

    // --- Ta-form (past) ---
    tryRule(word, 'た', 'る', 'past tense', candidates);
    for (const [ta, u] of GODAN_ONBIN_TA) {
        tryRule(word, ta, u, 'past tense', candidates);
    }

    // --- Negative (ない) ---
    tryRule(word, 'ない', 'る', 'negative', candidates);
    for (const [a, u] of GODAN_A) {
        tryRule(word, a + 'ない', u, 'negative', candidates);
    }

    // --- Negative past (なかった) ---
    tryRule(word, 'なかった', 'る', 'negative past', candidates);
    for (const [a, u] of GODAN_A) {
        tryRule(word, a + 'なかった', u, 'negative past', candidates);
    }

    // --- Tai (want to) ---
    tryRule(word, 'たい', 'る', 'tai-form', candidates);
    for (const [i, u] of GODAN_I) {
        tryRule(word, i + 'たい', u, 'tai-form', candidates);
    }

    // --- Potential ---
    tryRule(word, 'られる', 'る', 'potential', candidates);
    tryRule(word, 'れる', 'る', 'potential', candidates);
    for (const [e, u] of GODAN_E) {
        tryRule(word, e + 'る', u, 'potential', candidates);
    }

    // --- Passive ---
    tryRule(word, 'られる', 'る', 'passive', candidates);
    for (const [a, u] of GODAN_A) {
        tryRule(word, a + 'れる', u, 'passive', candidates);
    }

    // --- Causative ---
    tryRule(word, 'させる', 'る', 'causative', candidates);
    for (const [a, u] of GODAN_A) {
        tryRule(word, a + 'せる', u, 'causative', candidates);
    }

    // --- Volitional ---
    tryRule(word, 'よう', 'る', 'volitional', candidates);
    const GODAN_O = [
        ['おう', 'う'], ['こう', 'く'], ['ごう', 'ぐ'], ['そう', 'す'],
        ['とう', 'つ'], ['のう', 'ぬ'], ['ぼう', 'ぶ'], ['もう', 'む'], ['ろう', 'る'],
    ];
    for (const [o, u] of GODAN_O) {
        tryRule(word, o, u, 'volitional', candidates);
    }

    // --- Ba-conditional ---
    tryRule(word, 'れば', 'る', 'conditional', candidates);
    for (const [e, u] of GODAN_E) {
        tryRule(word, e + 'ば', u, 'conditional', candidates);
    }

    // --- Progressive (ている/てる) ---
    tryRule(word, 'ている', 'る', 'progressive', candidates);
    tryRule(word, 'てる', 'る', 'progressive', candidates);
    for (const [te, u] of GODAN_ONBIN) {
        const teFull = te.endsWith('て') ? te : te.slice(0, -1) + 'で';
        tryRule(word, teFull + 'いる', u, 'progressive', candidates);
        tryRule(word, teFull + 'る', u, 'progressive', candidates);
    }

    // --- i-adjective inflections ---
    tryRule(word, 'くない', 'い', 'negative (adj)', candidates);
    tryRule(word, 'かった', 'い', 'past (adj)', candidates);
    tryRule(word, 'くなかった', 'い', 'negative past (adj)', candidates);
    tryRule(word, 'くて', 'い', 'te-form (adj)', candidates);
    tryRule(word, 'さ', 'い', 'noun form (adj)', candidates);

    // Deduplicate: keep first occurrence of each (word, rule) pair
    const seen = new Set();
    return candidates.filter(c => {
        const key = `${c.word}|${c.rule}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
