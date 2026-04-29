import { getKanji, isKanjiDataLoaded } from './kanji-data.js';
import { getKnownKanji, toggleKnown } from './kanji-manager.js';

/**
 * Generic kanji tooltip module.
 * Provides a reusable hover tooltip for kanji characters that can be
 * attached to any container. Designed for use in both the Kanji Manager
 * popup and future in-message tooltip mode.
 *
 * Usage:
 *   attachKanjiTooltip(container, { boundingEl });
 *   detachKanjiTooltip(container);
 */

const TOOLTIP_ID = 'nihongo_kanji_tooltip';
const SHOW_DELAY = 300;
const HIDE_DELAY = 150;
const TOOLTIP_WIDTH = 280;
const TOOLTIP_MAX_HEIGHT = 350;

/** @type {HTMLElement|null} */
let tooltipEl = null;
/** @type {number|null} */
let showTimer = null;
/** @type {number|null} */
let hideTimer = null;
/** @type {string|null} */
let currentKey = null;
/** @type {HTMLElement|null} */
let tooltipParent = null;
/** @type {WeakMap<HTMLElement, { onMove: Function, onLeave: Function, onScroll: Function }>} */
const attachedContainers = new WeakMap();

/**
 * Ensures the tooltip DOM element exists.
 * @returns {HTMLElement}
 */
function ensureTooltip() {
    const parent = tooltipParent || document.body;
    if (tooltipEl && parent.contains(tooltipEl)) return tooltipEl;

    // Remove stale element if parent changed
    if (tooltipEl && tooltipEl.parentNode) {
        tooltipEl.parentNode.removeChild(tooltipEl);
    }

    tooltipEl = document.createElement('div');
    tooltipEl.id = TOOLTIP_ID;
    tooltipEl.className = 'nihongo-tooltip';
    tooltipEl.style.display = 'none';
    parent.appendChild(tooltipEl);

    // Keep tooltip visible while hovering over it
    tooltipEl.addEventListener('mouseenter', () => {
        cancelHide();
    });
    tooltipEl.addEventListener('mouseleave', () => {
        scheduleHide();
    });

    return tooltipEl;
}

/**
 * Renders a compact kanji block for use inside the word tooltip.
 * @param {string} char
 * @returns {string} HTML string
 */
function renderKanjiBlock(char) {
    const entry = getKanji(char);
    if (!entry) return '';
    const known = getKnownKanji();
    const isKnown = known.has(char);
    const knownClass = isKnown ? ' nihongo-wt-kanji-known' : '';
    return `
        <div class="nihongo-wt-kanji-block${knownClass}" data-kanji="${char}">
            <span class="nihongo-wt-kanji-char">${char}</span>
            <div class="nihongo-wt-kanji-info">
                <div class="nihongo-wt-kanji-meanings">${entry.m.slice(0, 3).join(', ')}</div>
                <div class="nihongo-wt-kanji-meta">
                    ${entry.on.length ? `<span class="nihongo-wt-kanji-reading">${entry.on.slice(0, 2).join('、')}</span>` : ''}
                    ${entry.kun.length ? `<span class="nihongo-wt-kanji-reading">${entry.kun.slice(0, 2).join('、')}</span>` : ''}
                    ${entry.jlpt ? `<span class="nihongo-tooltip-tag">N${entry.jlpt}</span>` : ''}
                    ${entry.f ? `<span class="nihongo-tooltip-tag">#${entry.f}</span>` : ''}
                    ${isKnown ? '<span class="nihongo-tooltip-tag nihongo-tooltip-tag-known">Known</span>' : ''}
                </div>
            </div>
        </div>
    `;
}

/**
 * Wires up all known toggle buttons inside the tooltip.
 * @param {HTMLElement} tip
 */
function wireKnownButtons(tip) {
    tip.querySelectorAll('.nihongo-tooltip-known-btn').forEach(knownBtn => {
        knownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ch = knownBtn.dataset.kanji;
            if (!ch) return;
            const nowKnown = toggleKnown(ch);
            // Update button
            const icon = knownBtn.querySelector('i');
            const span = knownBtn.querySelector('span');
            if (icon) icon.className = nowKnown ? 'fa-solid fa-star' : 'fa-regular fa-star';
            if (span) span.textContent = nowKnown ? 'Known' : 'Mark Known';
            // Update border on single-kanji tooltip
            const inner = tip.querySelector('.nihongo-tooltip-inner');
            if (inner) inner.classList.toggle('nihongo-tooltip-known', nowKnown);
            // Update known tag in the same block
            const block = knownBtn.closest('.nihongo-tooltip-inner, .nihongo-wt-kanji-block');
            if (block) {
                block.classList.toggle('nihongo-wt-kanji-known', nowKnown);
                block.classList.toggle('nihongo-tooltip-known', nowKnown);
                const existingTag = block.querySelector('.nihongo-tooltip-tag-known');
                if (nowKnown && !existingTag) {
                    const metaEl = block.querySelector('.nihongo-tooltip-meta, .nihongo-wt-kanji-meta');
                    if (metaEl) {
                        const tag = document.createElement('span');
                        tag.className = 'nihongo-tooltip-tag nihongo-tooltip-tag-known';
                        tag.textContent = 'Known';
                        metaEl.appendChild(tag);
                    }
                } else if (!nowKnown && existingTag) {
                    existingTag.remove();
                }
            }
            // Update the kanji spans in the DOM
            document.querySelectorAll(`.nihongo-kanji[data-kanji="${ch}"]`)
                .forEach(s => s.classList.toggle('nihongo-kanji-known', nowKnown));
        });
    });
}

/**
 * Populates tooltip content for a single kanji character.
 * @param {string} char
 * @returns {boolean} True if content was populated
 */
function populateKanjiTooltip(char) {
    const entry = getKanji(char);
    const tip = ensureTooltip();
    if (!entry) {
        tip.style.display = 'none';
        return false;
    }

    const known = getKnownKanji();
    const isKnown = known.has(char);
    const knownClass = isKnown ? ' nihongo-tooltip-known' : '';

    const jishoUrl = `https://jisho.org/search/${encodeURIComponent(char)}%20%23kanji`;

    tip.innerHTML = `
        <div class="nihongo-tooltip-inner${knownClass}">
            <div class="nihongo-tooltip-top">
                <span class="nihongo-tooltip-kanji">${char}</span>
                <div class="nihongo-tooltip-meanings">${entry.m.slice(0, 4).join(', ')}</div>
            </div>
            <div class="nihongo-tooltip-readings">
                ${entry.on.length ? `<div class="nihongo-tooltip-row"><span class="nihongo-tooltip-label">音</span><span>${entry.on.join('、 ')}</span></div>` : ''}
                ${entry.kun.length ? `<div class="nihongo-tooltip-row"><span class="nihongo-tooltip-label">訓</span><span>${entry.kun.join('、 ')}</span></div>` : ''}
            </div>
            <div class="nihongo-tooltip-meta">
                ${entry.jlpt ? `<span class="nihongo-tooltip-tag">N${entry.jlpt}</span>` : ''}
                ${entry.g ? `<span class="nihongo-tooltip-tag">${entry.g <= 6 ? 'G' + entry.g : 'JH'}</span>` : ''}
                ${entry.s ? `<span class="nihongo-tooltip-tag">${entry.s}画</span>` : ''}
                ${entry.f ? `<span class="nihongo-tooltip-tag">#${entry.f}</span>` : ''}
                ${isKnown ? '<span class="nihongo-tooltip-tag nihongo-tooltip-tag-known">Known</span>' : ''}
            </div>
            <div class="nihongo-tooltip-actions">
                <button class="nihongo-tooltip-known-btn interactable" data-kanji="${char}" title="Toggle known status">
                    <i class="${isKnown ? 'fa-solid' : 'fa-regular'} fa-star"></i>
                    <span>${isKnown ? 'Known' : 'Mark Known'}</span>
                </button>
                <a class="nihongo-tooltip-jisho-link" href="${jishoUrl}" target="_blank" rel="noopener" title="Look up on Jisho.org">
                    Jisho ↗
                </a>
            </div>
        </div>
    `;

    wireKnownButtons(tip);
    return true;
}

/**
 * Populates tooltip content for a word (with kanji breakdown).
 * @param {string} word The surface form
 * @param {string} reading The hiragana reading
 * @param {string} pos Part of speech from kuromoji
 * @returns {boolean} True if content was populated
 */
function populateWordTooltip(word, reading, pos) {
    const tip = ensureTooltip();

    const jishoUrl = `https://jisho.org/search/${encodeURIComponent(word)}%20%23words`;

    // Extract kanji characters in order of appearance
    const kanjiChars = [];
    for (const ch of word) {
        if (getKanji(ch) && !kanjiChars.includes(ch)) {
            kanjiChars.push(ch);
        }
    }

    const kanjiBlocksHtml = kanjiChars.length > 0 && isKanjiDataLoaded()
        ? `<div class="nihongo-wt-kanji-section">
               <div class="nihongo-wt-section-label">Kanji</div>
               ${kanjiChars.map(renderKanjiBlock).join('')}
           </div>`
        : '';

    tip.innerHTML = `
        <div class="nihongo-tooltip-inner nihongo-wt-inner">
            <div class="nihongo-wt-word-section">
                <div class="nihongo-wt-word-top">
                    <span class="nihongo-wt-word">${word}</span>
                    ${reading && reading !== word ? `<span class="nihongo-wt-reading">${reading}</span>` : ''}
                </div>
                ${pos ? `<div class="nihongo-wt-pos">${pos}</div>` : ''}
                <div class="nihongo-wt-meaning-placeholder">Meaning lookup not yet available</div>
                <div class="nihongo-tooltip-actions">
                    <a class="nihongo-tooltip-jisho-link" href="${jishoUrl}" target="_blank" rel="noopener" title="Look up on Jisho.org">
                        Jisho ↗
                    </a>
                </div>
            </div>
            ${kanjiBlocksHtml}
        </div>
    `;

    wireKnownButtons(tip);
    return true;
}

/**
 * Positions the tooltip relative to a target element, constrained within
 * a bounding element. Prefers right side, then left, then below.
 * @param {HTMLElement} target The hovered kanji tile/element
 * @param {HTMLElement} [boundingEl] The constraining ancestor (e.g. popup dialog)
 */
function positionTooltip(target, boundingEl) {
    const tip = ensureTooltip();
    tip.style.display = '';
    tip.style.visibility = 'hidden';
    tip.style.position = 'fixed';
    tip.style.width = `${TOOLTIP_WIDTH}px`;
    tip.style.maxHeight = `${TOOLTIP_MAX_HEIGHT}px`;

    // Force layout so we can measure
    const tipRect = tip.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    // Bounding box: either the constraining element or the viewport
    const bounds = boundingEl
        ? boundingEl.getBoundingClientRect()
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

    const gap = 8;
    let left, top;

    // Try right side of target
    left = targetRect.right + gap;
    top = targetRect.top;

    if (left + TOOLTIP_WIDTH > bounds.right) {
        // Try left side
        left = targetRect.left - TOOLTIP_WIDTH - gap;
    }

    if (left < bounds.left) {
        // Fallback: below target, horizontally centered
        left = targetRect.left + (targetRect.width / 2) - (TOOLTIP_WIDTH / 2);
        top = targetRect.bottom + gap;
    }

    // Vertical constraint
    const tipHeight = tipRect.height || TOOLTIP_MAX_HEIGHT;
    if (top + tipHeight > bounds.bottom) {
        top = bounds.bottom - tipHeight - gap;
    }
    if (top < bounds.top) {
        top = bounds.top + gap;
    }

    // Horizontal constraint
    if (left + TOOLTIP_WIDTH > bounds.right) {
        left = bounds.right - TOOLTIP_WIDTH - gap;
    }
    if (left < bounds.left) {
        left = bounds.left + gap;
    }

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = '';
}

function cancelShow() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
}

function cancelHide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function scheduleHide() {
    cancelShow();
    hideTimer = setTimeout(() => {
        const tip = ensureTooltip();
        tip.style.display = 'none';
        currentKey = null;
    }, HIDE_DELAY);
}

/**
 * Finds the tooltip target from a hovered element.
 * Priority:
 *   1. .nihongo-km-tile[data-kanji] → kanji tooltip (Kanji Manager)
 *   2. .nihongo-word[data-word]     → word tooltip (in-message, contains kanji blocks)
 *   3. .nihongo-kanji[data-kanji]   → kanji tooltip fallback (in-message without word wrapper)
 * @param {EventTarget|null} target
 * @returns {{ type: 'word'|'kanji', key: string, el: HTMLElement, word?: string, reading?: string, pos?: string }|null}
 */
function findTooltipTarget(target) {
    if (!(target instanceof HTMLElement)) return null;
    // Kanji Manager tile — always kanji tooltip
    const tile = target.closest('.nihongo-km-tile[data-kanji]');
    if (tile) return { type: 'kanji', key: `k:${tile.dataset.kanji}`, el: tile, word: tile.dataset.kanji };
    // In-message word span — word tooltip
    const wordSpan = target.closest('.nihongo-word[data-word]');
    if (wordSpan) {
        const word = wordSpan.dataset.word;
        const reading = wordSpan.dataset.reading || '';
        const pos = wordSpan.dataset.pos || '';
        return { type: 'word', key: `w:${word}`, el: wordSpan, word, reading, pos };
    }
    // Fallback: bare kanji span (without word wrapper)
    const kanjiSpan = target.closest('.nihongo-kanji[data-kanji]');
    if (kanjiSpan) return { type: 'kanji', key: `k:${kanjiSpan.dataset.kanji}`, el: kanjiSpan, word: kanjiSpan.dataset.kanji };
    return null;
}

/**
 * Attaches kanji tooltip hover behavior to a container.
 * @param {HTMLElement} container The element to listen on (delegated)
 * @param {Object} [options]
 * @param {HTMLElement} [options.boundingEl] Constraining element for positioning
 * @param {HTMLElement} [options.appendTo] Where to append the tooltip DOM (default: document.body). Use the dialog element for modal popups.
 */
export function attachKanjiTooltip(container, options = {}) {
    if (attachedContainers.has(container)) return;

    const boundingEl = options.boundingEl || null;
    tooltipParent = options.appendTo || null;

    const onMove = (e) => {
        const found = findTooltipTarget(e.target);
        if (!found) {
            if (currentKey) scheduleHide();
            return;
        }

        cancelHide();

        if (found.key === currentKey) return;

        cancelShow();
        showTimer = setTimeout(() => {
            let ok = false;
            if (found.type === 'word') {
                ok = populateWordTooltip(found.word, found.reading || '', found.pos || '');
            } else {
                ok = populateKanjiTooltip(found.word);
            }
            if (!ok) return;
            positionTooltip(found.el, boundingEl);
            currentKey = found.key;
        }, currentKey ? 50 : SHOW_DELAY);
    };

    const onLeave = () => {
        scheduleHide();
    };

    const onScroll = () => {
        cancelShow();
        const tip = ensureTooltip();
        tip.style.display = 'none';
        currentKey = null;
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    container.addEventListener('scroll', onScroll, true);

    attachedContainers.set(container, { onMove, onLeave, onScroll });
}

/**
 * Detaches kanji tooltip behavior from a container.
 * @param {HTMLElement} container
 */
export function detachKanjiTooltip(container) {
    const handlers = attachedContainers.get(container);
    if (!handlers) return;

    container.removeEventListener('mousemove', handlers.onMove);
    container.removeEventListener('mouseleave', handlers.onLeave);
    container.removeEventListener('scroll', handlers.onScroll, true);
    attachedContainers.delete(container);
}

/**
 * Destroys the tooltip element. Call on cleanup.
 */
export function destroyTooltip() {
    cancelShow();
    cancelHide();
    if (tooltipEl && tooltipEl.parentNode) {
        tooltipEl.parentNode.removeChild(tooltipEl);
    }
    tooltipEl = null;
    currentKey = null;
}

// ===== Chat Inspect Mode =====

const INSPECT_CLASS = 'nihongo-inspect-mode';
const INDICATOR_ID = 'nihongo_inspect_indicator';
let inspectActive = false;
/** @type {HTMLElement|null} */
let inspectContainer = null;
/** @type {((e: KeyboardEvent) => void)|null} */
let inspectEscHandler = null;

/**
 * Returns whether chat inspect mode is currently active.
 * @returns {boolean}
 */
export function isChatInspectActive() {
    return inspectActive;
}

/**
 * Enables kanji inspect mode on the chat area.
 * Hover over any kanji in messages to see a tooltip with details.
 */
export function enableChatInspect() {
    if (inspectActive) return;
    const chat = document.getElementById('chat');
    if (!chat) return;

    inspectActive = true;
    inspectContainer = chat;
    tooltipParent = null; // append to body (no modal in the way)
    chat.classList.add(INSPECT_CLASS);

    attachKanjiTooltip(chat);

    // Hide the wand dropdown menu
    const dropdown = document.getElementById('extensionsMenu');
    if (dropdown) dropdown.style.display = 'none';

    // Floating indicator bar
    let indicator = document.getElementById(INDICATOR_ID);
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = INDICATOR_ID;
        indicator.className = 'nihongo-inspect-indicator';
        indicator.innerHTML = `
            <span>Kanji Inspect Mode</span>
            <span class="nihongo-inspect-hint">Hover kanji for details · Ctrl+Shift+K to toggle</span>
            <button class="nihongo-inspect-close interactable" title="Exit inspect mode">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        document.body.appendChild(indicator);
        indicator.querySelector('.nihongo-inspect-close')?.addEventListener('click', disableChatInspect);
    }
    indicator.style.display = '';

    // Escape to exit
    inspectEscHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            disableChatInspect();
        }
    };
    document.addEventListener('keydown', inspectEscHandler, true);
}

/**
 * Registers the global Ctrl+Shift+K keyboard shortcut to toggle inspect mode.
 * Call once during initialization.
 */
export function registerInspectShortcut() {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'K') {
            e.preventDefault();
            e.stopPropagation();
            toggleChatInspect();
        }
    });
}

/**
 * Disables kanji inspect mode.
 */
export function disableChatInspect() {
    if (!inspectActive) return;
    inspectActive = false;

    if (inspectContainer) {
        inspectContainer.classList.remove(INSPECT_CLASS);
        detachKanjiTooltip(inspectContainer);
        inspectContainer = null;
    }

    destroyTooltip();

    const indicator = document.getElementById(INDICATOR_ID);
    if (indicator) indicator.style.display = 'none';

    if (inspectEscHandler) {
        document.removeEventListener('keydown', inspectEscHandler, true);
        inspectEscHandler = null;
    }
}

/**
 * Toggles kanji inspect mode.
 * @returns {boolean} New state
 */
export function toggleChatInspect() {
    if (inspectActive) {
        disableChatInspect();
    } else {
        enableChatInspect();
    }
    return inspectActive;
}
