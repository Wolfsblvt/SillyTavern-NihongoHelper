import { getKanji } from './kanji-data.js';
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
const TOOLTIP_WIDTH = 260;
const TOOLTIP_MAX_HEIGHT = 200;

/** @type {HTMLElement|null} */
let tooltipEl = null;
/** @type {number|null} */
let showTimer = null;
/** @type {number|null} */
let hideTimer = null;
/** @type {string|null} */
let currentChar = null;
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
 * Populates tooltip content for a kanji character.
 * @param {string} char
 * @returns {boolean} True if content was populated
 */
function populateTooltip(char) {
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

    // Wire up known toggle button
    const knownBtn = tip.querySelector('.nihongo-tooltip-known-btn');
    if (knownBtn) {
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
            // Update border
            const inner = tip.querySelector('.nihongo-tooltip-inner');
            if (inner) inner.classList.toggle('nihongo-tooltip-known', nowKnown);
            // Update known tag
            const meta = tip.querySelector('.nihongo-tooltip-meta');
            if (meta) {
                const existingTag = meta.querySelector('.nihongo-tooltip-tag-known');
                if (nowKnown && !existingTag) {
                    const tag = document.createElement('span');
                    tag.className = 'nihongo-tooltip-tag nihongo-tooltip-tag-known';
                    tag.textContent = 'Known';
                    meta.appendChild(tag);
                } else if (!nowKnown && existingTag) {
                    existingTag.remove();
                }
            }
            // Update the kanji span in the DOM if in chat inspect mode
            const chatSpans = document.querySelectorAll(`.nihongo-kanji[data-kanji="${ch}"]`);
            chatSpans.forEach(s => s.classList.toggle('nihongo-kanji-known', nowKnown));
        });
    }

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
        currentChar = null;
    }, HIDE_DELAY);
}

/**
 * Finds the kanji character from a hovered element.
 * Works with:
 *   - .nihongo-km-tile[data-kanji] (Kanji Manager grid)
 *   - .nihongo-kanji[data-kanji]   (in-message kanji spans)
 * @param {EventTarget|null} target
 * @returns {{ char: string, el: HTMLElement }|null}
 */
function findKanjiTarget(target) {
    if (!(target instanceof HTMLElement)) return null;
    // Kanji Manager tile
    const tile = target.closest('.nihongo-km-tile[data-kanji]');
    if (tile) return { char: tile.dataset.kanji, el: tile };
    // In-message kanji span
    const span = target.closest('.nihongo-kanji[data-kanji]');
    if (span) return { char: span.dataset.kanji, el: span };
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
        const found = findKanjiTarget(e.target);
        if (!found) {
            if (currentChar) scheduleHide();
            return;
        }

        cancelHide();

        if (found.char === currentChar) return;

        cancelShow();
        showTimer = setTimeout(() => {
            if (!populateTooltip(found.char)) return;
            positionTooltip(found.el, boundingEl);
            currentChar = found.char;
        }, currentChar ? 50 : SHOW_DELAY); // Faster switch between kanji
    };

    const onLeave = () => {
        scheduleHide();
    };

    const onScroll = () => {
        cancelShow();
        const tip = ensureTooltip();
        tip.style.display = 'none';
        currentChar = null;
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
    currentChar = null;
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
