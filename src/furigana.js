import { EXTENSION_NAME } from '../index.js';
import { nihongoSettings } from './settings.js';

/** @type {any} */
let tokenizer = null;
let tokenizerLoading = false;

/**
 * Creates a debounced function.
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

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
 * Builds ruby HTML for a single token.
 * Tries to align furigana only over the kanji portions of the surface form.
 * @param {string} surface The surface form (as written)
 * @param {string} reading The reading in hiragana
 * @returns {string} HTML string
 */
function buildRuby(surface, reading) {
    // If the surface has no kanji, no ruby needed
    if (!containsKanji(surface)) {
        return surface;
    }

    // Simple case: entire surface is kanji
    const allKanji = [...surface].every(isKanji);
    if (allKanji) {
        return `<ruby>${surface}<rp>(</rp><rt>${reading}</rt><rp>)</rp></ruby>`;
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

    // Strip matching kana from reading to isolate the kanji reading
    let remainingReading = reading;

    // Strip from front
    for (const part of parts) {
        if (part.type === 'kana') {
            const kana = katakanaToHiragana(part.text);
            if (remainingReading.startsWith(kana)) {
                remainingReading = remainingReading.slice(kana.length);
            }
        } else {
            break;
        }
    }

    // Strip from back
    for (let j = parts.length - 1; j >= 0; j--) {
        if (parts[j].type === 'kana') {
            const kana = katakanaToHiragana(parts[j].text);
            if (remainingReading.endsWith(kana)) {
                remainingReading = remainingReading.slice(0, -kana.length);
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
            html += `<ruby>${part.text}<rp>(</rp><rt>${remainingReading}</rt><rp>)</rp></ruby>`;
            readingUsed = true;
        } else {
            html += part.text;
        }
    }

    return html;
}

/**
 * Processes a text string and returns HTML with furigana annotations.
 * @param {string} text Raw text content
 * @returns {string} HTML with ruby annotations
 */
function addFuriganaToText(text) {
    if (!tokenizer || !containsKanji(text)) {
        return text;
    }

    const tokens = tokenizer.tokenize(text);
    let result = '';

    for (const token of tokens) {
        const surface = token.surface_form;
        const reading = token.reading;

        if (reading && containsKanji(surface)) {
            const hiraganaReading = katakanaToHiragana(reading);
            result += buildRuby(surface, hiraganaReading);
        } else {
            result += surface;
        }
    }

    return result;
}

/**
 * Strips previously injected furigana from an element, restoring original text nodes.
 * @param {HTMLElement} element
 */
function stripFurigana(element) {
    element.querySelectorAll('.nihongo-processed').forEach(el => {
        const parent = el.parentNode;
        if (!parent) return;
        // Replace the processed span with its original text content
        const textNode = document.createTextNode(el.textContent || '');
        parent.replaceChild(textNode, el);
        // Normalize to merge adjacent text nodes
        parent.normalize();
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

    // If already processed, strip first if forcing, otherwise skip
    if (element.querySelector('.nihongo-processed')) {
        if (!force) return;
        stripFurigana(element);
    }

    // Walk all text nodes
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            // Skip if inside a ruby element, code block, or already processed
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest('ruby, code, pre, .nihongo-processed')) return NodeFilter.FILTER_REJECT;
            if (!containsKanji(node.textContent || '')) return NodeFilter.FILTER_REJECT;
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
        if (html !== text) {
            const span = document.createElement('span');
            span.classList.add('nihongo-processed');
            span.innerHTML = html;
            textNode.parentNode?.replaceChild(span, textNode);
        }
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
 * Manages cached furigana HTML for streaming messages.
 * Caches the tokenized result for a known prefix so that when ST replaces innerHTML
 * on each streaming frame, we can instantly re-apply furigana for the already-processed
 * portion and only run the expensive tokenizer on new text.
 */
class StreamingFuriganaCache {
    constructor() {
        /** Last raw text we fully tokenized */
        this.processedText = '';
        /** Cached token results as array of {surface, html} */
        this.cachedTokens = [];
        /** Full HTML output for the processed text */
        this.cachedHTML = '';
    }

    /**
     * Resets the cache (e.g., when a new message starts streaming).
     */
    reset() {
        this.processedText = '';
        this.cachedTokens = [];
        this.cachedHTML = '';
    }

    /**
     * Processes text, reusing cached results for any matching prefix.
     * @param {string} fullText The full text of the streaming message
     * @returns {string} HTML with furigana for the full text
     */
    process(fullText) {
        if (!tokenizer || !containsKanji(fullText)) {
            return fullText;
        }

        // If the new text starts with our cached text, only tokenize the new part
        if (fullText.startsWith(this.processedText) && this.processedText.length > 0) {
            const newPart = fullText.slice(this.processedText.length);
            if (!newPart || !containsKanji(newPart)) {
                // No new kanji, just append the new text
                return this.cachedHTML + newPart;
            }
        }

        // Full re-tokenize (cache miss or text changed)
        const result = addFuriganaToText(fullText);
        this.processedText = fullText;
        this.cachedHTML = result;
        return result;
    }
}

/** Streaming cache instance */
const streamingCache = new StreamingFuriganaCache();

/**
 * Processes the currently streaming message using cached results.
 * @param {HTMLElement} element The .mes_text element being streamed
 */
function processStreamingElement(element) {
    if (!tokenizer || !nihongoSettings.enabled) return;

    // Extract plain text from the element (ST has already formatted markdown)
    // We walk text nodes and process them individually, same as static messages
    // but using the cache for the overall text to avoid re-tokenizing everything
    processMessageElement(element, true);
}

/**
 * Initializes the furigana system.
 */
export async function initFurigana() {
    const { eventSource, eventTypes } = SillyTavern.getContext();

    // Load tokenizer (async, non-blocking for init)
    loadTokenizer().then(() => {
        // Once loaded, process existing messages
        processAllMessages();
    });

    // === Message render events (new messages) ===
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (messageId) => onMessageRendered(messageId));
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, (messageId) => onMessageRendered(messageId));

    // === Chat lifecycle events ===
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        streamingCache.reset();
        setTimeout(processAllMessages, 100);
    });

    // === Message edit/update events — force re-processing ===
    eventSource.on(eventTypes.MESSAGE_EDITED, (messageId) => onMessageRendered(messageId, true));
    eventSource.on(eventTypes.MESSAGE_UPDATED, (messageId) => onMessageRendered(messageId, true));
    eventSource.on(eventTypes.MESSAGE_SWIPED, () => {
        // On swipe, the last message is replaced
        setTimeout(processAllMessages, 100);
    });

    // === Reasoning events ===
    eventSource.on(eventTypes.MESSAGE_REASONING_EDITED, (messageId) => onMessageRendered(messageId, true));

    // === More messages loaded (lazy loading / scrolling up) ===
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, () => {
        setTimeout(processAllMessages, 100);
    });

    // === Streaming ===
    // Debounced tokenizer run for new streaming content
    const debouncedStreamProcess = debounce(() => {
        if (!tokenizer || !nihongoSettings.enabled) return;
        const lastMes = document.querySelector('#chat .mes:last-child .mes_text');
        if (lastMes instanceof HTMLElement) {
            processStreamingElement(lastMes);
        }
    }, 250);

    eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, debouncedStreamProcess);

    // Reset streaming cache when generation starts
    eventSource.on(eventTypes.GENERATION_STARTED, () => {
        streamingCache.reset();
    });

    console.debug(`[${EXTENSION_NAME}] Furigana system initialized`);
}
