/**
 * Romaji-to-kana conversion module.
 *
 * Converts ASCII romaji input to hiragana for dictionary lookup.
 * Supports standard Hepburn romanization + common variants (si→し, ti→ち, etc.)
 *
 * Design: A simple longest-prefix table lookup. Not a full IME —
 * just enough for search input conversion.
 */

// Sorted longest-first so we match multi-char sequences before single chars
const ROMAJI_TABLE = [
    // 4-char
    ['xtsu', 'っ'], ['ltsu', 'っ'],
    // 3-char (digraphs + y-combos)
    ['sha', 'しゃ'], ['shi', 'し'], ['shu', 'しゅ'], ['sho', 'しょ'],
    ['chi', 'ち'], ['tsu', 'つ'], ['cha', 'ちゃ'], ['chu', 'ちゅ'], ['cho', 'ちょ'],
    ['tya', 'ちゃ'], ['tyi', 'ちぃ'], ['tyu', 'ちゅ'], ['tye', 'ちぇ'], ['tyo', 'ちょ'],
    ['cya', 'ちゃ'], ['cyi', 'ちぃ'], ['cyu', 'ちゅ'], ['cye', 'ちぇ'], ['cyo', 'ちょ'],
    ['kya', 'きゃ'], ['kyi', 'きぃ'], ['kyu', 'きゅ'], ['kye', 'きぇ'], ['kyo', 'きょ'],
    ['gya', 'ぎゃ'], ['gyi', 'ぎぃ'], ['gyu', 'ぎゅ'], ['gye', 'ぎぇ'], ['gyo', 'ぎょ'],
    ['nya', 'にゃ'], ['nyi', 'にぃ'], ['nyu', 'にゅ'], ['nye', 'にぇ'], ['nyo', 'にょ'],
    ['hya', 'ひゃ'], ['hyi', 'ひぃ'], ['hyu', 'ひゅ'], ['hye', 'ひぇ'], ['hyo', 'ひょ'],
    ['bya', 'びゃ'], ['byi', 'びぃ'], ['byu', 'びゅ'], ['bye', 'びぇ'], ['byo', 'びょ'],
    ['pya', 'ぴゃ'], ['pyi', 'ぴぃ'], ['pyu', 'ぴゅ'], ['pye', 'ぴぇ'], ['pyo', 'ぴょ'],
    ['mya', 'みゃ'], ['myi', 'みぃ'], ['myu', 'みゅ'], ['mye', 'みぇ'], ['myo', 'みょ'],
    ['rya', 'りゃ'], ['ryi', 'りぃ'], ['ryu', 'りゅ'], ['rye', 'りぇ'], ['ryo', 'りょ'],
    ['jya', 'じゃ'], ['jyi', 'じぃ'], ['jyu', 'じゅ'], ['jye', 'じぇ'], ['jyo', 'じょ'],
    ['dya', 'ぢゃ'], ['dyi', 'ぢぃ'], ['dyu', 'ぢゅ'], ['dye', 'ぢぇ'], ['dyo', 'ぢょ'],
    ['shi', 'し'], ['she', 'しぇ'],
    ['dha', 'でゃ'], ['dhi', 'でぃ'], ['dhu', 'でゅ'], ['dhe', 'でぇ'], ['dho', 'でょ'],
    ['tha', 'てゃ'], ['thi', 'てぃ'], ['thu', 'てゅ'], ['the', 'てぇ'], ['tho', 'てょ'],
    ['fya', 'ふゃ'], ['fyu', 'ふゅ'], ['fyo', 'ふょ'],
    // 2-char (basic kana)
    ['ka', 'か'], ['ki', 'き'], ['ku', 'く'], ['ke', 'け'], ['ko', 'こ'],
    ['sa', 'さ'], ['si', 'し'], ['su', 'す'], ['se', 'せ'], ['so', 'そ'],
    ['ta', 'た'], ['ti', 'ち'], ['tu', 'つ'], ['te', 'て'], ['to', 'と'],
    ['na', 'な'], ['ni', 'に'], ['nu', 'ぬ'], ['ne', 'ね'], ['no', 'の'],
    ['ha', 'は'], ['hi', 'ひ'], ['hu', 'ふ'], ['he', 'へ'], ['ho', 'ほ'],
    ['ma', 'ま'], ['mi', 'み'], ['mu', 'む'], ['me', 'め'], ['mo', 'も'],
    ['ya', 'や'], ['yi', 'い'], ['yu', 'ゆ'], ['ye', 'いぇ'], ['yo', 'よ'],
    ['ra', 'ら'], ['ri', 'り'], ['ru', 'る'], ['re', 'れ'], ['ro', 'ろ'],
    ['wa', 'わ'], ['wi', 'ゐ'], ['wu', 'う'], ['we', 'ゑ'], ['wo', 'を'],
    ['ga', 'が'], ['gi', 'ぎ'], ['gu', 'ぐ'], ['ge', 'げ'], ['go', 'ご'],
    ['za', 'ざ'], ['zi', 'じ'], ['zu', 'ず'], ['ze', 'ぜ'], ['zo', 'ぞ'],
    ['da', 'だ'], ['di', 'ぢ'], ['du', 'づ'], ['de', 'で'], ['do', 'ど'],
    ['ba', 'ば'], ['bi', 'び'], ['bu', 'ぶ'], ['be', 'べ'], ['bo', 'ぼ'],
    ['pa', 'ぱ'], ['pi', 'ぴ'], ['pu', 'ぷ'], ['pe', 'ぺ'], ['po', 'ぽ'],
    ['fa', 'ふぁ'], ['fi', 'ふぃ'], ['fu', 'ふ'], ['fe', 'ふぇ'], ['fo', 'ふぉ'],
    ['ja', 'じゃ'], ['ji', 'じ'], ['ju', 'じゅ'], ['je', 'じぇ'], ['jo', 'じょ'],
    ['va', 'ゔぁ'], ['vi', 'ゔぃ'], ['vu', 'ゔ'], ['ve', 'ゔぇ'], ['vo', 'ゔぉ'],
    ['xa', 'ぁ'], ['xi', 'ぃ'], ['xu', 'ぅ'], ['xe', 'ぇ'], ['xo', 'ぉ'],
    ['la', 'ぁ'], ['li', 'ぃ'], ['lu', 'ぅ'], ['le', 'ぇ'], ['lo', 'ぉ'],
    // 1-char vowels
    ['a', 'あ'], ['i', 'い'], ['u', 'う'], ['e', 'え'], ['o', 'お'],
    // N standalone (handled specially below)
    ['n', 'ん'],
];

/**
 * Converts a romaji string to hiragana.
 * Handles double consonants (→ っ), 'n' before consonants/end (→ ん),
 * and long vowels (ou → おう).
 *
 * @param {string} input Romaji string (ASCII, case-insensitive)
 * @returns {string} Hiragana string
 */
export function romajiToHiragana(input) {
    const str = input.toLowerCase();
    let result = '';
    let i = 0;

    while (i < str.length) {
        // Double consonant → っ (e.g., "kk" → っ + k)
        if (i + 1 < str.length && str[i] === str[i + 1] && isConsonant(str[i]) && str[i] !== 'n') {
            result += 'っ';
            i++;
            continue;
        }

        // 'n' before consonant or end → ん (but not before vowel or 'y')
        if (str[i] === 'n' && i + 1 < str.length) {
            const next = str[i + 1];
            if (next !== 'a' && next !== 'i' && next !== 'u' && next !== 'e' && next !== 'o' && next !== 'y' && next !== 'n') {
                result += 'ん';
                i++;
                continue;
            }
        }

        // Try longest match from table
        let matched = false;
        for (const [romaji, kana] of ROMAJI_TABLE) {
            if (str.startsWith(romaji, i)) {
                result += kana;
                i += romaji.length;
                matched = true;
                break;
            }
        }

        if (!matched) {
            // Pass through non-romaji characters (punctuation, etc.)
            result += str[i];
            i++;
        }
    }

    return result;
}

/**
 * Detects whether a string looks like romaji (ASCII Latin letters only).
 * Returns false if it contains any Japanese characters.
 * @param {string} str
 * @returns {boolean}
 */
export function isRomaji(str) {
    if (!str || str.length === 0) return false;
    // Must be all ASCII letters (+ common punctuation like hyphen, space)
    return /^[a-zA-Z\s\-']+$/.test(str) && str.length >= 2;
}

function isConsonant(ch) {
    return 'bcdfghjklmnpqrstvwxyz'.includes(ch);
}
