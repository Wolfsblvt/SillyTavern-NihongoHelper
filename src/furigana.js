import { EXTENSION_NAME } from '../index.js';
import { nihongoSettings } from './settings.js';
import { getKnownKanji } from './kanji-manager.js';
import { getKanji as getKanjiEntry } from './kanji-data.js';
import { analyzeTokens, registerSpanMatches } from './token-matcher.js';
import { recordSeen } from './tracking.js';

/** @type {any} */
let tokenizer = null;
let tokenizerLoading = false;


/**
 * Checks if a character is a kanji.
 * @param {string} ch Single character
 * @returns {boolean}
 */
function isKanji(ch) {
    const code = ch.charCodeAt(0);
    // CJK Unified Ideographs: U+4E00 - U+9FFF
    // CJK Unified Ideographs Extension A: U+3400 - U+4DBF
    // CJK Compatibility Ideographs: U+F900 - U+FAFF
    return (code >= 0x4E00 && code <= 0x9FFF)
        || (code >= 0x3400 && code <= 0x4DBF)
        || (code >= 0xF900 && code <= 0xFAFF);
}

/**
 * Checks if a string contains any kanji.
 * @param {string} text
 * @returns {boolean}
 */
function containsKanji(text) {
    for (const ch of text) {
        if (isKanji(ch)) return true;
    }
    return false;
}

/**
 * Checks if a character is Japanese (kanji, hiragana, katakana).
 * @param {string} ch Single character
 * @returns {boolean}
 */
function isJapanese(ch) {
    const code = ch.charCodeAt(0);
    return isKanji(ch)
        || (code >= 0x3040 && code <= 0x309F)  // Hiragana
        || (code >= 0x30A0 && code <= 0x30FF)  // Katakana
        || (code >= 0xFF66 && code <= 0xFF9F); // Half-width Katakana
}

/**
 * Checks if a string contains any Japanese characters.
 * @param {string} text
 * @returns {boolean}
 */
function containsJapanese(text) {
    for (const ch of text) {
        if (isJapanese(ch)) return true;
    }
    return false;
}

/**
 * Converts katakana to hiragana.
 * @param {string} str
 * @returns {string}
 */
function katakanaToHiragana(str) {
    return str.replace(/[\u30A1-\u30F6]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0x60),
    );
}

/**
 * Escapes a string for use in an HTML attribute value.
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Wraps individual kanji characters with spans containing data attributes.
 * Each kanji gets class="nihongo-kanji" plus data-kanji, data-freq, data-jlpt, data-grade.
 * Known kanji additionally get class="nihongo-kanji-known".
 * @param {string} kanjiStr One or more kanji characters
 * @param {Set<string>|Map<string, any>} known Known kanji collection
 * @returns {string} HTML with per-kanji spans
 */
function wrapKanji(kanjiStr, known) {
    let out = '';
    for (const ch of kanjiStr) {
        if (!isKanji(ch)) {
            out += ch;
            continue;
        }
        const entry = getKanjiEntry(ch);
        const classes = ['nihongo-kanji'];
        if (known.has(ch)) classes.push('nihongo-kanji-known');

        const attrs = [`data-kanji="${ch}"`];
        if (entry) {
            if (entry.f) attrs.push(`data-freq="${entry.f}"`);
            if (entry.jlpt) attrs.push(`data-jlpt="${entry.jlpt}"`);
            if (entry.g) attrs.push(`data-grade="${entry.g}"`);
        }
        out += `<span class="${classes.join(' ')}" ${attrs.join(' ')}>${ch}</span>`;
    }
    return out;
}

/**
 * Builds ruby HTML for a single token.
 * Tries to align furigana only over the kanji portions of the surface form.
 * @param {string} surface The surface form (as written)
 * @param {string} reading The reading in hiragana
 * @param {Set<string>|Map<string, any>} known Known kanji collection
 * @returns {string} HTML string
 */
function buildRuby(surface, reading, known) {
    // If the surface has no kanji, no ruby needed
    if (!containsKanji(surface)) {
        return surface;
    }

    // Simple case: entire surface is kanji
    const allKanji = [...surface].every(isKanji);
    if (allKanji) {
        return `<ruby>${wrapKanji(surface, known)}<rt>${reading}</rt></ruby>`;
    }

    // Mixed kanji/kana: try to split and align readings
    // Find leading kana, kanji block, trailing kana
    const parts = [];
    let i = 0;
    while (i < surface.length) {
        const start = i;
        if (isKanji(surface[i])) {
            while (i < surface.length && isKanji(surface[i])) i++;
            parts.push({ type: 'kanji', text: surface.slice(start, i) });
        } else {
            while (i < surface.length && !isKanji(surface[i])) i++;
            parts.push({ type: 'kana', text: surface.slice(start, i) });
        }
    }

    // Strip matching kana from reading to isolate the kanji reading.
    // Clean non-kana chars (zero-width spaces, punctuation from markdown) so they don't
    // break the startsWith / endsWith alignment.
    let remainingReading = reading;

    // Strip from front
    for (const part of parts) {
        if (part.type === 'kana') {
            const kanaClean = katakanaToHiragana(part.text).replace(/[^\u3040-\u309F]/g, '');
            if (kanaClean.length > 0 && remainingReading.startsWith(kanaClean)) {
                remainingReading = remainingReading.slice(kanaClean.length);
            }
        } else {
            break;
        }
    }

    // Strip from back
    for (let j = parts.length - 1; j >= 0; j--) {
        if (parts[j].type === 'kana') {
            const kanaClean = katakanaToHiragana(parts[j].text).replace(/[^\u3040-\u309F]/g, '');
            if (kanaClean.length > 0 && remainingReading.endsWith(kanaClean)) {
                remainingReading = remainingReading.slice(0, -kanaClean.length);
            }
        } else {
            break;
        }
    }

    // Build HTML
    let readingUsed = false;
    let html = '';
    for (const part of parts) {
        if (part.type === 'kanji' && !readingUsed) {
            html += `<ruby>${wrapKanji(part.text, known)}<rt>${remainingReading}</rt></ruby>`;
            readingUsed = true;
        } else if (part.type === 'kanji') {
            html += wrapKanji(part.text, known);
        } else {
            html += part.text;
        }
    }

    return html;
}

/**
 * Processes a text string and returns HTML with furigana annotations.
 * Uses the multi-token matching engine for greedy span grouping.
 * @param {string} text Raw text content
 * @returns {string} HTML with ruby annotations
 */
function addFuriganaToText(text) {
    if (!tokenizer || !containsJapanese(text)) {
        return text;
    }

    const tokens = tokenizer.tokenize(text);
    const spans = analyzeTokens(tokens);
    const known = getKnownKanji();
    let result = '';

    for (const span of spans) {
        const { surface, reading, matches } = span;
        const hasKanjiChar = containsKanji(surface);
        const isJp = containsJapanese(surface);

        if (!isJp) {
            // Non-Japanese text (punctuation, latin, etc.)
            result += surface;
            continue;
        }

        // Determine if this span is hoverable
        const hasMatches = matches.length > 0;
        const isHoverable = hasKanjiChar || (nihongoSettings.kanaWordTooltips && hasMatches);

        // Build inner HTML
        let inner = '';
        if (hasKanjiChar) {
            // Check if furigana should be hidden (all kanji known)
            const kanjiChars = [...surface].filter(isKanji);
            const allKnown = nihongoSettings.hideKnownFurigana && known.size > 0 && kanjiChars.length > 0 && kanjiChars.every(ch => known.has(ch));

            if (allKnown || !reading) {
                inner = wrapKanji(surface, known);
            } else {
                inner = buildRuby(surface, reading, known);
            }
        } else {
            inner = surface;
        }

        // Build data attributes
        const attrs = [`data-word="${escapeAttr(surface)}"`];
        if (reading) attrs.push(`data-reading="${escapeAttr(reading)}"`);

        // Get POS from first token in span
        const firstToken = tokens[span.start];
        if (firstToken && firstToken.pos) attrs.push(`data-pos="${escapeAttr(firstToken.pos)}"`);

        // Register matches and add match-id attribute
        if (hasMatches) {
            const matchId = registerSpanMatches(matches);
            if (matchId) attrs.push(`data-match-id="${matchId}"`);
        }

        // CSS class: kana-only words with matches get class for potential styling
        // (actual visual styling is controlled by CSS scoping on parent classes)
        const classes = ['nihongo-word'];
        if (!hasKanjiChar && hasMatches) classes.push('nihongo-word-kana');

        result += `<span class="${classes.join(' ')}" ${attrs.join(' ')}>${inner}</span>`;
    }

    return result;
}

/**
 * Strips previously injected furigana from an element, restoring original text nodes.
 * Uses data-original attribute to avoid including ruby annotation text.
 * @param {HTMLElement} element
 */
function stripFurigana(element) {
    element.querySelectorAll('.nihongo-processed').forEach(el => {
        const parent = el.parentNode;
        if (!parent) return;
        // Prefer stored original text (avoids including <rt> content)
        let originalText = el.getAttribute('data-original');
        if (originalText == null) {
            // Fallback: clone and remove rt elements to get clean text
            const clone = /** @type {Element} */ (el.cloneNode(true));
            clone.querySelectorAll('rt').forEach(rt => rt.remove());
            originalText = clone.textContent || '';
        }
        const textNode = document.createTextNode(originalText);
        parent.replaceChild(textNode, el);
        // Normalize to merge adjacent text nodes
        parent.normalize();
    });
}

/**
 * Scans a processed element for matched words and records them as seen
 * in the tracking system. Only call on first-time processing.
 * @param {HTMLElement} element
 */
function trackSeenWords(element) {
    const seen = new Set();
    element.querySelectorAll('.nihongo-word[data-word]').forEach(el => {
        const word = el.getAttribute('data-word');
        if (word && !seen.has(word)) {
            seen.add(word);
            recordSeen(word);
        }
    });
}

/**
 * Processes a message element, adding furigana to its text content.
 * Walks text nodes inside the element and wraps kanji with ruby annotations.
 * @param {HTMLElement} element The message element to process
 * @param {boolean} [force=false] Force re-processing even if already processed
 */
function processMessageElement(element, force = false) {
    if (!tokenizer || !nihongoSettings.enabled) return;

    // Track whether this is a first-time process (for word tracking)
    const isFirstPass = !element.querySelector('.nihongo-processed');

    // If already processed, strip first if forcing, otherwise skip
    if (!isFirstPass) {
        if (!force) return;
        stripFurigana(element);
    }

    // Walk all text nodes that contain any Japanese characters
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            // Skip if inside a ruby element, code block, or already processed
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest('ruby, code, pre, .nihongo-processed')) return NodeFilter.FILTER_REJECT;
            if (!containsJapanese(node.textContent || '')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    for (const textNode of textNodes) {
        const text = textNode.textContent || '';
        const html = addFuriganaToText(text);
        const span = document.createElement('span');
        span.classList.add('nihongo-processed');
        span.setAttribute('data-original', text);
        span.innerHTML = html;
        textNode.parentNode?.replaceChild(span, textNode);
    }

    // Auto-track seen words on first-time processing only
    if (isFirstPass) {
        trackSeenWords(element);
    }
}

/**
 * Processes all messages currently in the chat.
 * @param {boolean} [force=false] Force re-processing
 */
function processAllMessages(force = false) {
    if (!tokenizer || !nihongoSettings.enabled) return;

    const messageTexts = document.querySelectorAll('#chat .mes .mes_text, #chat .mes .mes_reasoning');
    for (const el of messageTexts) {
        if (el instanceof HTMLElement) {
            processMessageElement(el, force);
        }
    }
}

/**
 * Re-processes messages that contain a specific kanji character.
 * Used after toggling known state to immediately update furigana.
 * @param {string} char The kanji character
 */
export function reprocessMessagesWithKanji(char) {
    if (!tokenizer || !nihongoSettings.enabled) return;
    const spans = document.querySelectorAll(`#chat .nihongo-kanji[data-kanji="${char}"]`);
    const processed = new Set();
    for (const span of spans) {
        const mesText = span.closest('.mes_text, .mes_reasoning');
        if (mesText instanceof HTMLElement && !processed.has(mesText)) {
            processed.add(mesText);
            processMessageElement(mesText, true);
        }
    }
}

/**
 * Loads the kuromoji browser script via script tag.
 * @returns {Promise<void>}
 */
function loadKuromojiScript() {
    return new Promise((resolve, reject) => {
        if (window.kuromoji) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = '/scripts/extensions/third-party/SillyTavern-NihongoHelper/lib/kuromoji/kuromoji.js';
        script.onload = () => resolve();
        script.onerror = (err) => reject(err);
        document.head.appendChild(script);
    });
}

/**
 * Loads the kuromoji tokenizer.
 * @returns {Promise<void>}
 */
async function loadTokenizer() {
    if (tokenizer || tokenizerLoading) return;
    tokenizerLoading = true;

    console.debug(`[${EXTENSION_NAME}] Loading kuromoji tokenizer...`);

    try {
        await loadKuromojiScript();
        tokenizer = await new Promise((resolve, reject) => {
            window.kuromoji.builder({ dicPath: '/scripts/extensions/third-party/SillyTavern-NihongoHelper/lib/kuromoji/dict/' }).build((err, built) => {
                if (err) reject(err);
                else resolve(built);
            });
        });
        console.debug(`[${EXTENSION_NAME}] Kuromoji tokenizer loaded successfully`);
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Failed to load kuromoji tokenizer:`, err);
        toastr.error(
            'NihongoHelper: Failed to load the Japanese tokenizer (kuromoji). Check the console for details.',
            'Kuromoji Load Failed',
        );
        tokenizer = null;
    } finally {
        tokenizerLoading = false;
    }
}

/**
 * Event handler for when a message is rendered or updated.
 * @param {number} messageId The message ID
 * @param {boolean} [force=false] Force re-processing
 */
function onMessageRendered(messageId, force = false) {
    if (!tokenizer || !nihongoSettings.enabled) return;

    const messageEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageEl) return;

    const mesText = messageEl.querySelector('.mes_text');
    if (mesText instanceof HTMLElement) {
        processMessageElement(mesText, force);
    }

    const mesReasoning = messageEl.querySelector('.mes_reasoning');
    if (mesReasoning instanceof HTMLElement) {
        processMessageElement(mesReasoning, force);
    }
}

/**
 * Processes an HTML string, adding furigana to its text content.
 * Parses into a temp container, walks text nodes, adds ruby, serializes back.
 * @param {string} html Formatted HTML string
 * @returns {string} HTML with furigana annotations
 */
function addFuriganaToHTML(html) {
    if (!tokenizer || !nihongoSettings.enabled) return html;

    const container = document.createElement('div');
    container.innerHTML = html;

    // Walk text nodes (same logic as processMessageElement but on a temp container)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest('ruby, code, pre, .nihongo-processed')) return NodeFilter.FILTER_REJECT;
            if (!containsJapanese(node.textContent || '')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    if (textNodes.length === 0) return html;

    for (const textNode of textNodes) {
        const text = textNode.textContent || '';
        const result = addFuriganaToText(text);
        const span = document.createElement('span');
        span.classList.add('nihongo-processed');
        span.setAttribute('data-original', text);
        span.innerHTML = result;
        textNode.parentNode?.replaceChild(span, textNode);
    }

    return container.innerHTML;
}

/**
 * Initializes the furigana system.
 */
export async function initFurigana() {
    const { eventSource, eventTypes, messageFormatter } = SillyTavern.getContext();

    // Register formatting hook — processes HTML before it hits the DOM.
    // This covers all paths: streaming tokens, initial render, swipes, edits, etc.
    messageFormatter.addHook((mes, ctx) => {
        if (ctx.isSystem) return mes;
        return addFuriganaToHTML(mes);
    });

    // Load tokenizer (async, non-blocking for init)
    loadTokenizer().then(() => {
        // Once loaded, process existing messages already in the DOM
        processAllMessages();
    });

    // === Chat lifecycle events ===
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        setTimeout(processAllMessages, 100);
    });

    // === Message edit/update events — force re-processing ===
    eventSource.on(eventTypes.MESSAGE_EDITED, (messageId) => onMessageRendered(messageId, true));
    eventSource.on(eventTypes.MESSAGE_UPDATED, (messageId) => onMessageRendered(messageId, true));
    eventSource.on(eventTypes.MESSAGE_SWIPED, () => {
        setTimeout(processAllMessages, 100);
    });

    // === Reasoning events ===
    eventSource.on(eventTypes.MESSAGE_REASONING_EDITED, (messageId) => onMessageRendered(messageId, true));

    // === More messages loaded (lazy loading / scrolling up) ===
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, () => {
        setTimeout(processAllMessages, 100);
    });

    console.debug(`[${EXTENSION_NAME}] Furigana system initialized`);
}
