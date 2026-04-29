import { getKanji, isKanjiDataLoaded } from './kanji-data.js';
import { getKnownKanji, toggleKnown } from './kanji-manager.js';
import { lookupMeaning, isMeaningAvailable } from './meaning-provider.js';
import { nihongoSettings } from './settings.js';
import { deinflect } from './deinflect.js';

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
const HIDE_DELAY = 400;
const TOOLTIP_WIDTH = 320;
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
/** @type {HTMLElement|null} - the element the cursor is currently over (target or tooltip) */
let hoveredTarget = null;
/** @type {{ key: string, el: HTMLElement, type: string, word?: string, reading?: string, pos?: string }|null} */
let pendingTarget = null;
/** @type {boolean} */
let mouseOverTooltip = false;
/** @type {boolean} - true while the user is dragging a text selection */
let isSelecting = false;
/** @type {{ word: string }|null} - non-null when a selection tooltip should persist (even during peek) */
let selectionState = null;
/** @type {WeakMap<HTMLElement, { onMove: Function, onLeave: Function, onScroll: Function, onMouseDown?: Function, onMouseUp?: Function }>} */
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
        mouseOverTooltip = true;
        cancelHide();
    });
    tooltipEl.addEventListener('mouseleave', () => {
        mouseOverTooltip = false;
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
                    ${entry.on.length ? `<span class="nihongo-wt-kanji-reading"><span class="nihongo-wt-reading-label">音</span>${entry.on.slice(0, 2).join('、')}</span>` : ''}
                    ${entry.kun.length ? `<span class="nihongo-wt-kanji-reading"><span class="nihongo-wt-reading-label">訓</span>${entry.kun.slice(0, 2).join('、')}</span>` : ''}
                    ${entry.jlpt ? `<span class="nihongo-tooltip-tag">N${entry.jlpt}</span>` : ''}
                    ${entry.f ? `<span class="nihongo-tooltip-tag">#${entry.f}</span>` : ''}
                </div>
            </div>
            <button class="nihongo-tooltip-known-btn nihongo-wt-known-toggle" data-kanji="${char}" title="${isKnown ? 'Mark as not known' : 'Mark as known'}">
                <i class="${isKnown ? 'fa-solid' : 'fa-regular'} fa-circle-check"></i>
            </button>
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
            // Update button icon
            const icon = knownBtn.querySelector('i');
            if (icon) icon.className = nowKnown ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle-check';
            // Update button text if present
            const span = knownBtn.querySelector('span');
            if (span) span.textContent = nowKnown ? 'Known' : 'Mark Known';
            // Update title
            knownBtn.title = nowKnown ? 'Mark as not known' : 'Mark as known';
            // Update border on standalone kanji tooltip
            const inner = tip.querySelector('.nihongo-tooltip-inner');
            if (inner) inner.classList.toggle('nihongo-tooltip-known', nowKnown);
            // Update kanji block in word tooltip
            const block = knownBtn.closest('.nihongo-wt-kanji-block');
            if (block) block.classList.toggle('nihongo-wt-kanji-known', nowKnown);
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
            </div>
            <div class="nihongo-tooltip-actions">
                <button class="nihongo-tooltip-known-btn interactable" data-kanji="${char}" title="${isKnown ? 'Mark as not known' : 'Mark as known'}">
                    <i class="${isKnown ? 'fa-solid' : 'fa-regular'} fa-circle-check"></i>
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
 * Groups consecutive senses that share the same POS into sections,
 * then renders Jisho-style HTML with numbered definitions.
 * @param {Object} meaningResult from lookupMeaning()
 * @returns {string} HTML string
 */
function renderSenses(meaningResult) {
    if (!meaningResult || !meaningResult.senses.length) return '';

    // Group consecutive senses by POS
    const groups = [];
    let lastPosKey = null;
    for (const sense of meaningResult.senses) {
        const posKey = sense.pos.join(', ');
        if (posKey !== lastPosKey) {
            groups.push({ pos: posKey, defs: [] });
            lastPosKey = posKey;
        }
        groups[groups.length - 1].defs.push(sense);
    }

    const spoiler = nihongoSettings.meaningSpoiler;
    const spoilerAttr = spoiler !== 'off' ? ` data-spoiler="${spoiler}"` : '';

    let defNum = 1;
    let html = `<div class="nihongo-wt-senses"${spoilerAttr}>`;
    for (const group of groups) {
        if (group.pos) {
            html += `<div class="nihongo-wt-pos-header">${group.pos}</div>`;
        }
        for (const def of group.defs) {
            html += `<div class="nihongo-wt-def">`;
            html += `<span class="nihongo-wt-def-num">${defNum}.</span>`;
            html += `<span>${def.glosses.join('; ')}</span>`;
            html += '</div>';
            const notes = [...(def.misc || []), ...(def.info || []), ...(def.field || [])];
            if (notes.length) {
                html += `<div class="nihongo-wt-def-notes">${notes.join(', ')}</div>`;
            }
            defNum++;
        }
    }
    html += '</div>';
    return html;
}

/**
 * Tries to resolve a word via deinflection.
 * @param {string} word
 * @param {string} [reading]
 * @returns {{ baseWord: string, meaning: Object, inflection: { from: string, rule: string } }|null}
 */
function resolveWithDeinflection(word, reading) {
    if (!isMeaningAvailable()) return null;
    const candidates = deinflect(word);
    for (const candidate of candidates) {
        const meaning = lookupMeaning(candidate.word, reading);
        if (meaning) {
            return { baseWord: candidate.word, meaning, inflection: { from: word, rule: candidate.rule } };
        }
    }
    return null;
}

/**
 * @param {string} word
 * @param {string} reading
 * @param {string} pos
 * @param {{ from: string, rule: string }|null} [inflection]
 */
function populateWordTooltip(word, reading, pos, inflection = null) {
    const tip = ensureTooltip();
    const originalWord = word;

    // Look up meanings from dictionary
    const meaning = lookupMeaning(word, reading);
    let sensesHtml = renderSenses(meaning);
    let inflectionHtml = '';

    // If no direct match, try deinflection
    if (!meaning && !inflection) {
        const resolved = resolveWithDeinflection(word, reading);
        if (resolved) {
            inflection = resolved.inflection;
            sensesHtml = renderSenses(resolved.meaning);
            // Use base word for kanji breakdown
            word = resolved.baseWord;
        }
    }

    // Render inflection note if present
    if (inflection) {
        inflectionHtml = `
            <div class="nihongo-wt-inflection">
                <span class="nihongo-wt-inflection-from">${inflection.from}</span>
                <span class="nihongo-wt-inflection-label">${inflection.rule} of</span>
                <span class="nihongo-wt-inflection-base">${word}</span>
            </div>`;
    }

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

    // Nothing useful to show — bail
    if (!sensesHtml && kanjiChars.length === 0) return false;

    const jishoUrl = `https://jisho.org/search/${encodeURIComponent(originalWord)}%20%23words`;

    // Use POS from dictionary if available, fall back to kuromoji POS
    const displayPos = meaning && meaning.senses.length ? '' : (pos ? `<div class="nihongo-wt-pos">${pos}</div>` : '');

    tip.innerHTML = `
        <div class="nihongo-tooltip-inner nihongo-wt-inner">
            <div class="nihongo-wt-word-section">
                ${inflectionHtml}
                <div class="nihongo-wt-word-top">
                    <span class="nihongo-wt-word">${word}</span>
                    ${reading && reading !== word ? `<span class="nihongo-wt-reading">${reading}</span>` : ''}
                </div>
                ${displayPos}
                ${sensesHtml || '<div class="nihongo-wt-meaning-placeholder">No definition found</div>'}
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
    pendingTarget = null;
}

function cancelHide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

/** Hides the tooltip immediately. Does NOT clear selectionState — use clearSelection() for that. */
function hideTooltip() {
    cancelShow();
    cancelHide();
    const tip = ensureTooltip();
    tip.style.display = 'none';
    currentKey = null;
}

/**
 * Schedules a hide after HIDE_DELAY.
 * When the timer fires, re-checks whether the cursor is still over
 * the tooltip or the original target element — if so, cancels the hide.
 */
function scheduleHide() {
    cancelShow();
    cancelHide();
    hideTimer = setTimeout(() => {
        hideTimer = null;
        // If the mouse came back to the tooltip or a valid target, don't hide
        if (mouseOverTooltip || hoveredTarget) return;
        // If a selection tooltip should persist, restore it instead of hiding
        if (selectionState) {
            // Already showing the selection tooltip — just keep it
            if (currentKey === `sel:${selectionState.word}`) return;
            restoreSelectionTooltip();
            return;
        }
        const tip = ensureTooltip();
        tip.style.display = 'none';
        currentKey = null;
    }, HIDE_DELAY);
}

/**
 * Schedules showing a tooltip after SHOW_DELAY.
 * When the timer fires, re-checks whether the cursor is still over
 * the same target element — if not, cancels the show.
 * If another tooltip is currently visible, it is hidden right before
 * the new one appears (not before).
 */
function scheduleShow(found, boundingEl) {
    cancelShow();
    cancelHide();
    pendingTarget = found;
    showTimer = setTimeout(() => {
        showTimer = null;
        // Verify cursor is still over this target
        if (!hoveredTarget || (pendingTarget && pendingTarget.key !== found.key)) {
            pendingTarget = null;
            return;
        }
        pendingTarget = null;
        // Hide any currently visible tooltip before showing the new one
        if (currentKey) {
            const tip = ensureTooltip();
            tip.style.display = 'none';
            currentKey = null;
        }
        let ok = false;
        if (found.type === 'word') {
            ok = populateWordTooltip(found.word, found.reading || '', found.pos || '');
        } else {
            ok = populateKanjiTooltip(found.word);
        }
        if (!ok) return;
        positionTooltip(found.el, boundingEl);
        currentKey = found.key;
        // selectionState is intentionally NOT cleared — this is a "peek" tooltip
    }, SHOW_DELAY);
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
        const hasKanji = /[\u4e00-\u9faf\u3400-\u4dbf]/.test(word);
        // Only show hover tooltip for words containing kanji
        if (hasKanji) {
            const reading = wordSpan.dataset.reading || '';
            const pos = wordSpan.dataset.pos || '';
            return { type: 'word', key: `w:${word}`, el: wordSpan, word, reading, pos };
        }
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
        // Suppress hover tooltips while user is dragging a selection
        if (isSelecting) return;

        const found = findTooltipTarget(e.target);
        if (!found) {
            hoveredTarget = null;
            // Not over a valid target — schedule hide if tooltip is showing
            if (currentKey && !mouseOverTooltip) scheduleHide();
            return;
        }

        // Don't show hover tooltip for elements inside the current selection
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.containsNode(found.el, true)) {
            return;
        }

        hoveredTarget = found.el;
        cancelHide();

        // Already showing this exact tooltip
        if (found.key === currentKey) return;

        // Schedule the new tooltip — the old one will be hidden when the new one shows
        scheduleShow(found, boundingEl);
    };

    const onLeave = () => {
        hoveredTarget = null;
        scheduleHide();
    };

    const onScroll = () => {
        hoveredTarget = null;
        cancelShow();
        cancelHide();
        if (selectionState) {
            restoreSelectionTooltip();
            return;
        }
        hideTooltip();
    };

    const onMouseDown = () => {
        isSelecting = true;
        // Hide any hover tooltip immediately when starting a selection
        if (currentKey && !currentKey.startsWith('sel:')) {
            cancelShow();
            hideTooltip();
        }
    };

    const onMouseUp = () => {
        isSelecting = false;
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    container.addEventListener('scroll', onScroll, true);
    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('mouseup', onMouseUp);

    attachedContainers.set(container, { onMove, onLeave, onScroll, onMouseDown, onMouseUp });
}

/**
 * Detaches kanji tooltip behavior from a container.
 * @param {HTMLElement} container
 */
export function detachKanjiTooltip(container) {
    const handlers = attachedContainers.get(container);
    if (!handlers) return;
    if (handlers.onMouseDown) container.removeEventListener('mousedown', handlers.onMouseDown);
    if (handlers.onMouseUp) container.removeEventListener('mouseup', handlers.onMouseUp);

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
    hoveredTarget = null;
    mouseOverTooltip = false;
    pendingTarget = null;
    selectionState = null;
}

// ===== Selection Lookup Helpers =====

/** Regex matching strings composed entirely of Japanese characters (kanji, hiragana, katakana, prolonged sound mark). */
const JP_ONLY_RE = /^[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\u30FC]+$/;

/** Converts full-width katakana to hiragana for dictionary lookups. */
function katakanaToHiragana(str) {
    return str.replace(/[\u30A1-\u30F6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/**
 * Positions the tooltip near a DOMRect (e.g. from a text selection).
 * Prefers below-right, falls back to above.
 * @param {DOMRect} rect
 */
function positionTooltipAtRect(rect) {
    const tip = ensureTooltip();
    tip.style.display = '';
    tip.style.visibility = 'hidden';
    tip.style.position = 'fixed';
    tip.style.width = `${TOOLTIP_WIDTH}px`;
    tip.style.maxHeight = `${TOOLTIP_MAX_HEIGHT}px`;

    const tipRect = tip.getBoundingClientRect();
    const gap = 8;
    let left = rect.left;
    let top = rect.bottom + gap;

    // If below goes off-screen, show above
    const tipHeight = tipRect.height || TOOLTIP_MAX_HEIGHT;
    if (top + tipHeight > window.innerHeight) {
        top = rect.top - tipHeight - gap;
    }
    if (top < 0) top = gap;

    // Horizontal constraint
    if (left + TOOLTIP_WIDTH > window.innerWidth) {
        left = window.innerWidth - TOOLTIP_WIDTH - gap;
    }
    if (left < 0) left = gap;

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = '';
}

/**
 * Re-shows the selection tooltip from stored selectionState.
 * Verifies the selection is still active before restoring.
 */
function restoreSelectionTooltip() {
    if (!selectionState) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
        selectionState = null;
        return;
    }
    const ok = populateWordTooltip(selectionState.word, '', '');
    if (!ok) { selectionState = null; return; }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    positionTooltipAtRect(rect);
    currentKey = `sel:${selectionState.word}`;
}

/**
 * Handles mouseup inside chat in inspect mode.
 * If user selected Japanese text, looks it up in the dictionary and shows a tooltip.
 * If user clicked without selecting, dismisses the selection tooltip.
 */
function onSelectionLookup() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
        // Clicked without selecting — dismiss any active selection tooltip
        if (selectionState) {
            selectionState = null;
            hideTooltip();
        }
        return;
    }

    // New selection made — always dismiss previous selection tooltip
    if (selectionState) {
        selectionState = null;
        hideTooltip();
    }

    const text = sel.toString().trim();
    if (!text || text.length > 30) return; // sanity limit
    if (!JP_ONLY_RE.test(text)) return;
    if (!isMeaningAvailable()) return;

    // Also try katakana→hiragana conversion for lookup
    const asHiragana = katakanaToHiragana(text);
    const lookupWord = (asHiragana !== text && !lookupMeaning(text) && lookupMeaning(asHiragana)) ? asHiragana : text;

    // Hide any existing tooltip first
    hideTooltip();

    // populateWordTooltip handles direct match + deinflection fallback
    const ok = populateWordTooltip(lookupWord, '', '');
    if (!ok) return;

    // Position near the selection
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    positionTooltipAtRect(rect);
    currentKey = `sel:${text}`;
    selectionState = { word: text };
}

// ===== Chat Inspect Mode =====

const INSPECT_CLASS = 'nihongo-inspect-mode';
const INDICATOR_ID = 'nihongo_inspect_indicator';
let inspectActive = false;
/** @type {HTMLElement|null} */
let inspectContainer = null;
/** @type {((e: KeyboardEvent) => void)|null} */
let inspectEscHandler = null;
/** @type {(() => void)|null} */
let selectionHandler = null;
/** @type {(() => void)|null} */
let resizeHandler = null;

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

    // Selection lookup: mouseup on chat triggers dictionary lookup
    selectionHandler = () => onSelectionLookup();
    chat.addEventListener('mouseup', selectionHandler);

    // Reposition selection tooltip on window resize/zoom
    resizeHandler = () => {
        if (selectionState) restoreSelectionTooltip();
    };
    window.addEventListener('resize', resizeHandler);

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
            <span>Inspect Mode</span>
            <span class="nihongo-inspect-hint">Hover words · Select text to look up · Ctrl+Shift+K to toggle</span>
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
        if (selectionHandler) {
            inspectContainer.removeEventListener('mouseup', selectionHandler);
            selectionHandler = null;
        }
        inspectContainer = null;
    }

    destroyTooltip();

    if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
    }

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
