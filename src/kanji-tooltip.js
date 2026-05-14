import { getKanji, isKanjiDataLoaded } from './kanji-data.js';
import { getKnownKanji, toggleKnown } from './kanji-manager.js';
import { lookupMeaning, lookupAllMeanings, isMeaningAvailable } from './meaning-provider.js';
import { nihongoSettings } from './settings.js';
import { deinflect } from './deinflect.js';
import { reprocessMessagesWithKanji } from './furigana.js';
import { getStoredMatches } from './token-matcher.js';
import { nudgeConfidence, toggleFlag, getDerivedLevel, getConfidence, setConfidence, resetConfidence } from './tracking.js';
import { openDictSearch } from './dict-search-ui.js';
import { isFrequencyAvailable, getFrequencyTier, getCompositeFrequency, getFrequencyPercent } from './frequency.js';
import { triggerChatAction } from './side-chat.js';

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
/** @type {string} - Captured surface text from the last hovered word (persists after hoveredTarget clears) */
let lastSurfaceText = '';
/** @type {string} - Captured context sentence from the last hovered word's DOM position */
let lastContextSentence = '';
/** @type {number} - highest top position reached during card navigation (prevents jumping back down) */
let tooltipFloorTop = Infinity;
/** @type {{ word: string }|null} - non-null when a selection tooltip should persist (even during peek) */
let selectionState = null;
/** @type {number} Current tooltip page index (0-based) */
let currentPageIndex = 0;

/** @type {Map<string, string>} word → last selected nudge action (session-only) */
const nudgeSelections = new Map();
/** @type {Array<{ html: string, label: string, displayWord: string }>} All pages for the current tooltip */
let tooltipPages = [];
/** @type {WeakMap<HTMLElement, { onMove: Function, onLeave: Function, onScroll: Function, onMouseDown?: Function, onMouseUp?: Function, onWheel?: Function }>} */
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

    // Scroll on tooltip: Shift+Scroll always navigates pages.
    // Plain scroll navigates pages ONLY when hovering the tab titles list.
    // Otherwise let the event bubble (page scroll / meanings scroll).
    tooltipEl.addEventListener('wheel', (e) => {
        if (tooltipPages.length <= 1) return;
        const isShift = e.shiftKey;
        const overTabs = e.target instanceof HTMLElement && !!e.target.closest('.nihongo-wt-tabs-wrapper');
        if (!isShift && !overTabs) return; // let it bubble
        e.preventDefault();
        e.stopPropagation();
        showTooltipPage(currentPageIndex + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });

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
            // Update kanji block in word tooltip
            const block = knownBtn.closest('.nihongo-wt-kanji-block');
            if (block) block.classList.toggle('nihongo-wt-kanji-known', nowKnown);
            // Update the word-level known border
            const inner = tip.querySelector('.nihongo-tooltip-inner');
            if (inner) {
                const isWordTooltip = inner.classList.contains('nihongo-wt-inner');
                if (isWordTooltip) {
                    // Word tooltip: green border only when ALL kanji in the word are known
                    const allBlocks = tip.querySelectorAll('.nihongo-wt-kanji-block');
                    const allKnown = allBlocks.length > 0 && [...allBlocks].every(b => b.classList.contains('nihongo-wt-kanji-known'));
                    inner.classList.toggle('nihongo-tooltip-known', allKnown);
                } else {
                    // Standalone kanji tooltip: direct toggle
                    inner.classList.toggle('nihongo-tooltip-known', nowKnown);
                }
            }
            // Update the kanji spans in the DOM
            document.querySelectorAll(`.nihongo-kanji[data-kanji="${ch}"]`)
                .forEach(s => s.classList.toggle('nihongo-kanji-known', nowKnown));
            // Re-process affected messages to update furigana visibility
            reprocessMessagesWithKanji(ch);
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
function populateWordTooltip(word, reading, pos, inflection = null, matchId = '') {
    const tip = ensureTooltip();
    tooltipPages = [];
    currentPageIndex = 0;

    // Build pages from stored matches if available
    const storedMatches = matchId ? getStoredMatches(matchId) : null;
    if (storedMatches && storedMatches.length > 0) {
        const seen = new Set();
        const kanjiRe = /[\u4e00-\u9faf\u3400-\u4dbf]/;
        for (const match of storedMatches) {
            // Filter kana-only sub-matches when kana tooltips are disabled
            if (!nihongoSettings.kanaWordTooltips) {
                const displayWord = match.baseWord || match.word;
                if (!kanjiRe.test(match.word) && !kanjiRe.test(displayWord)) continue;
            }

            // Deduplicate by display word + source
            const dedup = `${match.baseWord || match.word}:${match.source}:${match.rule || ''}`;
            if (seen.has(dedup)) continue;
            seen.add(dedup);

            let pageWord = match.word;
            let pageReading = match.reading || reading;
            let pageInflection = null;

            if (match.source === 'deinflect' && match.baseWord) {
                pageInflection = { from: match.word, rule: match.rule || 'form' };
                pageWord = match.baseWord;
                // Look up reading for the base word
                const baseMeaning = lookupMeaning(match.baseWord);
                if (baseMeaning && baseMeaning.readings.length > 0) {
                    pageReading = baseMeaning.readings[0];
                }
            }

            const pages = buildWordPages(pageWord, pageReading, pos, pageInflection, null, match.word.length);
            tooltipPages.push(...pages);
        }
    }

    // Fallback: build pages from direct args (selection lookup or no stored matches)
    if (tooltipPages.length === 0) {
        const pages = buildWordPages(word, reading, pos, inflection, null, word.length);
        tooltipPages.push(...pages);
    }

    // Deduplicate pages by display word + label (same dict entry from different matches)
    const seenPages = new Set();
    tooltipPages = tooltipPages.filter(p => {
        const key = `${p.displayWord}:${p.label}`;
        if (seenPages.has(key)) return false;
        seenPages.add(key);
        return true;
    });

    // Sort pages: full surface match → not alt-writing → common → original order
    const hoveredLen = word.length;
    tooltipPages.forEach((p, i) => { p._origIdx = i; });
    tooltipPages.sort((a, b) => {
        // 1. Full surface match (surfaceLen == hovered text len) before sub-word
        const aFull = (a.surfaceLen || 0) >= hoveredLen ? 0 : 1;
        const bFull = (b.surfaceLen || 0) >= hoveredLen ? 0 : 1;
        if (aFull !== bFull) return aFull - bFull;
        // 2. Not alt-writing before alt-writing
        const aAlt = a.isAltWriting ? 1 : 0;
        const bAlt = b.isAltWriting ? 1 : 0;
        if (aAlt !== bAlt) return aAlt - bAlt;
        // 3. Common before non-common
        const aCom = a.isCommon ? 0 : 1;
        const bCom = b.isCommon ? 0 : 1;
        if (aCom !== bCom) return aCom - bCom;
        // 4. Longer surface before shorter
        const lenDiff = (b.surfaceLen || 0) - (a.surfaceLen || 0);
        if (lenDiff !== 0) return lenDiff;
        // 5. Original order
        return (a._origIdx || 0) - (b._origIdx || 0);
    });

    if (tooltipPages.length === 0) return false;

    showTooltipPage(0);
    return true;
}

/**
 * Builds tooltip page(s) for a word lookup. Returns multiple pages when
 * JMdict has multiple entries for the same word (e.g. かんたん → 感嘆, 簡単).
 * @param {string} word Surface form
 * @param {string} reading Reading
 * @param {string} pos POS tag
 * @param {{ from: string, rule: string }|null} inflection
 * @param {string|null} altWriting Canonical kanji form when this is an alternative writing
 * @returns {Array<{ html: string, label: string, displayWord: string }>}
 */
function buildWordPages(word, reading, pos, inflection = null, altWriting = null, surfaceLen = 0) {
    const originalWord = word;

    // Look up ALL meanings from dictionary
    let meanings = lookupAllMeanings(word, reading);

    // If no direct match, try deinflection
    if (meanings.length === 0 && !inflection) {
        const resolved = resolveWithDeinflection(word, reading);
        if (resolved) {
            inflection = resolved.inflection;
            meanings = lookupAllMeanings(resolved.baseWord);
            word = resolved.baseWord;
        }
    }

    // If still nothing, return a single fallback page
    if (meanings.length === 0) {
        const page = buildSinglePage(word, originalWord, reading, pos, inflection, altWriting, null, surfaceLen);
        return page ? [page] : [];
    }

    // Build a page for each dictionary entry
    const pages = [];
    for (const meaning of meanings) {
        // For entries with kanji forms, use the canonical form for display
        const displayWord = (meaning.forms && meaning.forms.length > 0) ? meaning.forms[0] : word;
        const displayReading = meaning.readings[0] || reading;

        // Detect alt writing per-entry: if the lookup word isn't one of the entry's kanji forms
        let entryAltWriting = altWriting;
        if (!entryAltWriting && meaning.forms && meaning.forms.length > 0) {
            const lookupW = inflection ? word : originalWord;
            if (!meaning.forms.includes(lookupW) && meaning.forms[0] !== lookupW) {
                entryAltWriting = meaning.forms[0];
            }
        }

        const page = buildSinglePage(displayWord, originalWord, displayReading, pos, inflection, entryAltWriting, meaning, surfaceLen);
        if (page) pages.push(page);
    }

    return pages;
}

/**
 * Builds a single tooltip page HTML from a resolved meaning.
 * @param {string} word Display word (may be canonical kanji form)
 * @param {string} originalWord Original surface form for Jisho link
 * @param {string} reading Reading
 * @param {string} pos POS tag
 * @param {{ from: string, rule: string }|null} inflection
 * @param {string|null} altWriting Canonical kanji form when this is an alternative writing
 * @param {Object|null} meaning Meaning result from lookupMeaning
 * @returns {{ html: string, label: string, displayWord: string }|null}
 */
function buildSinglePage(word, originalWord, reading, pos, inflection, altWriting, meaning, surfaceLen = 0) {
    let sensesHtml = renderSenses(meaning);
    let inflectionHtml = '';
    let altWritingHtml = '';

    // Render inflection note if present
    if (inflection) {
        inflectionHtml = `
            <div class="nihongo-wt-inflection">
                <span class="nihongo-wt-inflection-from">${inflection.from}</span>
                <span class="nihongo-wt-inflection-label">${inflection.rule} of</span>
                <span class="nihongo-wt-inflection-base">${word}</span>
            </div>`;
    }

    // Render alternative writing note if present
    if (altWriting) {
        altWritingHtml = `
            <div class="nihongo-wt-inflection nihongo-wt-alt-writing">
                <span class="nihongo-wt-inflection-label">alt. writing of</span>
                <span class="nihongo-wt-inflection-base">${altWriting}</span>
            </div>`;
    }

    // Extract kanji characters (from canonical form if available, else lookup word)
    const kanjiSource = altWriting || word;
    const kanjiChars = [];
    for (const ch of kanjiSource) {
        if (getKanji(ch) && !kanjiChars.includes(ch)) kanjiChars.push(ch);
    }

    const kanjiBlocksHtml = kanjiChars.length > 0 && isKanjiDataLoaded()
        ? `<div class="nihongo-wt-kanji-section">
               <div class="nihongo-wt-section-label">Kanji</div>
               ${kanjiChars.map(renderKanjiBlock).join('')}
           </div>`
        : '';

    if (!sensesHtml && kanjiChars.length === 0) return null;

    // Use canonical form for Jisho link when it's an alternative writing
    const jishoWord = altWriting || word || originalWord;
    const jishoUrl = `https://jisho.org/search/${encodeURIComponent(jishoWord)}%20%23words`;
    const displayPos = meaning && meaning.senses.length ? '' : (pos ? `<div class="nihongo-wt-pos">${pos}</div>` : '');
    const isCommon = meaning && meaning.common;

    const known = getKnownKanji();
    const wordKnownClass = kanjiChars.length > 0 && kanjiChars.every(ch => known.has(ch)) ? ' nihongo-tooltip-known' : '';

    // Build label for tab list — no JS truncation, CSS handles overflow
    const firstGloss = meaning && meaning.senses.length > 0 ? (meaning.senses[0].glosses[0] || '') : '';
    let label = word;
    if (inflection && firstGloss) {
        label = `${word} (${inflection.rule}) — ${firstGloss}`;
    } else if (inflection) {
        label = `${word} (${inflection.rule})`;
    } else if (firstGloss) {
        label = `${word} — ${firstGloss}`;
    }

    // Common word badge (icon-only when frequency is also shown)
    let commonBadge = '';
    if (isCommon) {
        const hasFreq = isFrequencyAvailable() && getFrequencyPercent(word, reading) !== null;
        commonBadge = hasFreq
            ? '<span class="nihongo-wt-common-badge" title="Common word"><i class="fa-solid fa-star"></i></span>'
            : '<span class="nihongo-wt-common-badge">common</span>';
    }

    // Frequency badge — percentage (log-scaled) with rank on hover
    let freqBadge = '';
    if (isFrequencyAvailable()) {
        const pct = getFrequencyPercent(word, reading);
        if (pct !== null) {
            const rank = getCompositeFrequency(word, reading);
            const tier = getFrequencyTier(word, reading);
            const tierClass = tier ? `nihongo-wt-freq-${tier}` : '';
            freqBadge = `<span class="nihongo-wt-freq-badge ${tierClass}" title="Frequency rank #${rank || '?'}">${pct}%</span>`;
        }
    }

    const html = `
        <div class="nihongo-tooltip-inner nihongo-wt-inner${wordKnownClass}">
            <div class="nihongo-wt-word-section">
                <div class="nihongo-wt-word-top">
                    <span class="nihongo-wt-word">${word}</span>
                    ${reading && reading !== word ? `<span class="nihongo-wt-reading">${reading}</span>` : ''}
                    ${commonBadge}${freqBadge}
                    <span class="nihongo-wt-header-actions">
                        <button class="nihongo-wt-header-btn nihongo-wt-btn-search" title="Search in dictionary" data-word="${word}"><i class="fa-solid fa-magnifying-glass"></i></button>
                        <button class="nihongo-wt-header-btn nihongo-wt-btn-copy" title="Copy word" data-word="${word}"><i class="fa-solid fa-copy"></i></button>
                        <a class="nihongo-wt-header-btn nihongo-wt-btn-jisho" href="${jishoUrl}" target="_blank" rel="noopener" title="Look up on Jisho.org"><i class="fa-solid fa-book-open"></i></a>
                    </span>
                </div>
                ${inflectionHtml}
                ${altWritingHtml}
                ${displayPos}
                ${sensesHtml || '<div class="nihongo-wt-meaning-placeholder">No definition found</div>'}
                <div class="nihongo-wt-chat-actions" data-word="${word}" data-reading="${reading || ''}">
                    <button class="nihongo-wt-chat-btn" data-chat-action="explain" title="Explain this word"><i class="fa-solid fa-circle-question"></i> Explain</button>
                    <button class="nihongo-wt-chat-btn" data-chat-action="translate" title="Translate in context"><i class="fa-solid fa-language"></i> Translate</button>
                    <button class="nihongo-wt-chat-btn" data-chat-action="alternatives" title="Synonyms & alternatives"><i class="fa-solid fa-arrows-split-up-and-left"></i> Alternatives</button>
                    <button class="nihongo-wt-chat-btn" data-chat-action="grammar" title="Explain grammar"><i class="fa-solid fa-spell-check"></i> Grammar</button>
                </div>
            </div>
            ${kanjiBlocksHtml}
        </div>
    `;

    return { html, label, displayWord: word, surfaceLen, isAltWriting: Boolean(altWriting), isCommon: Boolean(isCommon) };
}

/**
 * Renders the tab list HTML for paginated tooltips.
 * @param {Array<{ label: string }>} pages
 * @param {number} activeIndex
 * @returns {string}
 */
function renderTabList(pages, activeIndex) {
    if (pages.length <= 1) return '';
    const tabs = pages.map((p, i) => {
        const activeClass = i === activeIndex ? ' nihongo-wt-tab-active' : '';
        return `<div class="nihongo-wt-tab${activeClass}" data-tab-index="${i}">${p.label}</div>`;
    }).join('');
    return `<div class="nihongo-wt-tabs-wrapper"><div class="nihongo-wt-tabs">${tabs}</div><div class="nihongo-wt-tab-counter">${activeIndex + 1}/${pages.length}</div></div>`;
}

/**
 * Shows a specific page of the current paginated tooltip.
 * @param {number} index
 */
function showTooltipPage(index) {
    if (tooltipPages.length === 0) return;
    // Wrap around
    if (index < 0) index = tooltipPages.length - 1;
    if (index >= tooltipPages.length) index = 0;
    currentPageIndex = index;

    const tip = ensureTooltip();
    const page = tooltipPages[index];

    tip.innerHTML = `<div class="nihongo-tooltip-body">${renderTabList(tooltipPages, index)}${page.html}</div>${renderNudgeBar(page.displayWord)}`;
    wireKnownButtons(tip);
    wireTabClicks(tip);
    wireHeaderActions(tip);
    wireNudgeBar(tip, page.displayWord);

    // Auto-scroll tab list to keep active tab visible
    const tabContainer = tip.querySelector('.nihongo-wt-tabs');
    const activeTab = tip.querySelector('.nihongo-wt-tab-active');
    if (tabContainer && activeTab) {
        const cRect = tabContainer.getBoundingClientRect();
        const tRect = activeTab.getBoundingClientRect();
        // If tab is below visible area
        if (tRect.bottom > cRect.bottom) {
            tabContainer.scrollTop += tRect.bottom - cRect.bottom + 4;
        }
        // If tab is above visible area
        if (tRect.top < cRect.top) {
            tabContainer.scrollTop -= cRect.top - tRect.top + 4;
        }
    }

    // Readjust vertical position if tooltip now overflows the viewport.
    // Only move UP (never back down) to prevent jumpy behaviour.
    adjustTooltipOverflow();
}

/**
 * Wires click handlers on tab items.
 * @param {HTMLElement} tip
 */
function wireTabClicks(tip) {
    tip.querySelectorAll('.nihongo-wt-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(tab.getAttribute('data-tab-index') || '0', 10);
            showTooltipPage(idx);
        });
    });
}

/**
 * Renders the nudge action bar HTML — a visually separate strip below the tooltip.
 * @param {string} word The display word for tracking
 * @returns {string}
 */
function renderNudgeBar(word) {
    const level = getDerivedLevel(word);
    const conf = getConfidence(word);
    const confPct = (conf * 100).toFixed(0);
    const levelLabel = level !== 'unknown' ? level : '';
    const selected = nudgeSelections.get(word) || '';
    const confColor = confidenceColor(conf);

    const actions = [
        { key: 'EASY',   cls: 'nihongo-wt-nudge-easy',  icon: 'fa-regular fa-face-smile', tip: 'Easy — I know this well (+20%)' },
        { key: 'GOT_IT', cls: 'nihongo-wt-nudge-gotit', icon: 'fa-solid fa-check',        tip: 'Got it — I understand this (+10%)' },
        { key: 'MEH',    cls: 'nihongo-wt-nudge-meh',   icon: 'fa-regular fa-face-meh',   tip: 'Meh — not sure about this (-5%)' },
        { key: 'HARD',   cls: 'nihongo-wt-nudge-hard',  icon: 'fa-regular fa-face-frown', tip: 'Hard — I don\'t know this (-15%)' },
    ];

    const buttons = actions.map(a =>
        `<button class="nihongo-wt-nudge-btn ${a.cls}${a.key === selected ? ' selected' : ''}" data-action="${a.key}" title="${a.tip}"><i class="${a.icon}"></i></button>`
    ).join('');

    return `
        <div class="nihongo-wt-nudge-bar" data-word="${word}">
            <div class="nihongo-wt-nudge-buttons">
                ${buttons}
                <button class="nihongo-wt-nudge-btn nihongo-wt-nudge-anki" data-action="ANKI" title="Queue for Anki export">
                    <i class="fa-solid fa-bookmark"></i>
                </button>
                <button class="nihongo-wt-nudge-btn nihongo-wt-nudge-reset" data-action="RESET" title="Reset confidence to 0">
                    <i class="fa-solid fa-rotate-left"></i>
                </button>
            </div>
            <div class="nihongo-wt-conf-row">
                <div class="nihongo-wt-conf-bar">
                    <div class="nihongo-wt-conf-fill" style="width:${confPct}%;background:${confColor}"></div>
                </div>
                <span class="nihongo-wt-nudge-level" title="Confidence: ${confPct}%">${levelLabel} ${confPct}%</span>
            </div>
        </div>
    `;
}

/**
 * Returns a CSS color for a confidence value (0–1).
 * Red → Orange → Yellow → Green gradient.
 * @param {number} conf 0.0–1.0
 * @returns {string}
 */
function confidenceColor(conf) {
    if (conf <= 0)   return '#ef5350';
    if (conf < 0.3)  return '#ef5350';
    if (conf < 0.6)  return '#ffa726';
    if (conf < 0.85) return '#66bb6a';
    return '#4caf50';
}

/** @type {Map<string, number>} word → confidence value before first nudge in this session */
const preNudgeConfidence = new Map();

/**
 * Stores the confidence value before a nudge is applied (only first time per word per session).
 * @param {string} word
 */
function savePreNudgeConfidence(word) {
    if (!preNudgeConfidence.has(word)) {
        preNudgeConfidence.set(word, getConfidence(word));
    }
}

/**
 * Restores the confidence to its pre-nudge value.
 * @param {string} word
 */
function restorePreNudgeConfidence(word) {
    const saved = preNudgeConfidence.get(word);
    if (saved !== undefined) {
        setConfidence(word, saved);
    }
}

/**
 * Wires click handlers on the header action buttons (search, copy).
 * @param {HTMLElement} tip
 */
function wireHeaderActions(tip) {
    // Search button → open side panel with word
    tip.querySelectorAll('.nihongo-wt-btn-search').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const word = btn.getAttribute('data-word');
            if (word) openDictSearch(word);
        });
    });

    // Copy button → copy word to clipboard
    tip.querySelectorAll('.nihongo-wt-btn-copy').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const word = btn.getAttribute('data-word');
            if (word) {
                navigator.clipboard.writeText(word).catch(() => {});
                const icon = btn.querySelector('i');
                if (icon) {
                    icon.className = 'fa-solid fa-check';
                    setTimeout(() => { icon.className = 'fa-solid fa-copy'; }, 1200);
                }
            }
        });
    });

    // Chat action buttons → trigger side chat
    tip.querySelectorAll('.nihongo-wt-chat-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const actionId = btn.getAttribute('data-chat-action');
            const container = btn.closest('.nihongo-wt-chat-actions');
            const dictWord = container?.getAttribute('data-word') || '';

            if (actionId) {
                // Use captured surface text (set when hoveredTarget was still valid)
                const surfaceText = selectionState?.word || lastSurfaceText || dictWord;
                const sentence = lastContextSentence;

                triggerChatAction(actionId, {
                    word: surfaceText || dictWord,
                    dictWord: dictWord !== surfaceText ? dictWord : '',
                    sentence,
                });
            }
        });
    });
}

/**
 * Gets the visible text of an element, excluding ruby annotations (rt/rp).
 * For a span like <ruby>書<rt>か</rt></ruby>きます, returns "書きます".
 * @param {HTMLElement} el
 * @returns {string}
 */
function getTextWithoutRuby(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('rt, rp').forEach(node => node.remove());
    return clone.textContent?.trim() || '';
}

/**
 * Extracts a context sentence from the DOM element containing the hovered word.
 * Uses hoveredTarget's position in the DOM to find surrounding text directly,
 * without relying on text search (which fails for inflected/ruby-wrapped forms).
 * @returns {string} Context sentence or empty string
 */
function getContextSentence() {
    const sourceEl = hoveredTarget || pendingTarget?.el;
    if (!sourceEl) return '';

    // Find the containing message element
    const mesText = sourceEl.closest?.('.mes_text');
    if (!mesText) return '';

    // Strategy: get the text of the paragraph/block containing the word.
    // Walk up to find nearest block-level parent within .mes_text, or use the whole message.
    const blockParent = sourceEl.closest('p, div, li, blockquote, td');
    const contextEl = (blockParent && mesText.contains(blockParent)) ? blockParent : mesText;
    const text = contextEl.textContent || '';

    // Truncate long contexts
    if (text.length > 300) {
        // Try to find the word's position via the source element's text
        const wordText = sourceEl.textContent?.trim() || '';
        const idx = wordText ? text.indexOf(wordText) : -1;
        if (idx >= 0) {
            const start = Math.max(0, idx - 100);
            const end = Math.min(text.length, idx + wordText.length + 100);
            let snippet = text.slice(start, end).trim();
            if (start > 0) snippet = '...' + snippet;
            if (end < text.length) snippet = snippet + '...';
            return snippet;
        }
        return text.slice(0, 300) + '...';
    }

    return text.trim();
}

/**
 * Wires click handlers on the nudge bar buttons.
 * Confidence buttons are mutually exclusive — clicking one deselects the previous.
 * Selection is remembered per word for the session.
 * @param {HTMLElement} tip
 * @param {string} word
 */
function wireNudgeBar(tip, word) {
    const bar = tip.querySelector('.nihongo-wt-nudge-bar');
    if (!bar) return;

    bar.querySelectorAll('.nihongo-wt-nudge-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.getAttribute('data-action');
            if (!action) return;

            if (action === 'RESET') {
                resetConfidence(word);
                nudgeSelections.delete(word);
                // Deselect all buttons
                bar.querySelectorAll('.nihongo-wt-nudge-btn').forEach(b => {
                    b.classList.remove('selected', 'active');
                });
            } else if (action === 'ANKI') {
                toggleFlag(word, 'anki-queued');
                btn.classList.toggle('active');
            } else {
                // Deselect all confidence buttons first
                bar.querySelectorAll('.nihongo-wt-nudge-btn:not([data-action="ANKI"]):not([data-action="RESET"])').forEach(b => {
                    b.classList.remove('selected');
                });

                const previousAction = nudgeSelections.get(word);

                // Save pre-nudge confidence before first interaction
                savePreNudgeConfidence(word);

                if (previousAction === action) {
                    // Clicking the already-selected action → restore original confidence
                    restorePreNudgeConfidence(word);
                    nudgeSelections.delete(word);
                    preNudgeConfidence.delete(word);
                } else {
                    // Switching or first click — restore to baseline, then apply new
                    restorePreNudgeConfidence(word);
                    nudgeConfidence(word, action.toLowerCase());
                    btn.classList.add('selected');
                    nudgeSelections.set(word, action);
                }
            }

            updateNudgeBarState(tip, word);
        });
    });
}

/**
 * Updates the nudge bar's level/confidence display and bar after a nudge action.
 * @param {HTMLElement} tip
 * @param {string} word
 */
function updateNudgeBarState(tip, word) {
    const level = getDerivedLevel(word);
    const conf = getConfidence(word);
    const confPct = (conf * 100).toFixed(0);
    const confColor = confidenceColor(conf);
    const levelLabel = level !== 'unknown' ? level : '';

    const levelEl = tip.querySelector('.nihongo-wt-nudge-level');
    if (levelEl) {
        levelEl.textContent = `${levelLabel} ${confPct}%`;
        levelEl.title = `Confidence: ${confPct}%`;
    }

    const fillEl = tip.querySelector('.nihongo-wt-conf-fill');
    if (fillEl) {
        fillEl.style.width = `${confPct}%`;
        fillEl.style.background = confColor;
    }
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
    const maxH = Math.min(window.innerHeight * 0.7, 500);
    tip.style.maxHeight = `${maxH}px`;

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
    const tipHeight = tipRect.height || maxH;
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

/**
 * After showing a (possibly taller) page, nudge the tooltip upward
 * if its bottom extends past the viewport. Tracks a floor so we
 * never jump back down when switching to a shorter page.
 */
function adjustTooltipOverflow() {
    if (!tooltipEl || tooltipEl.style.display === 'none') return;
    const tipRect = tooltipEl.getBoundingClientRect();
    const gap = 8;
    const overflow = tipRect.bottom - (window.innerHeight - gap);
    if (overflow > 0) {
        const currentTop = parseFloat(tooltipEl.style.top) || tipRect.top;
        const newTop = Math.max(gap, currentTop - overflow);
        // Only move up, never back down
        if (newTop < tooltipFloorTop) {
            tooltipFloorTop = newTop;
        }
        tooltipEl.style.top = `${tooltipFloorTop}px`;
    }
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
    tooltipFloorTop = Infinity;
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
            ok = populateWordTooltip(found.word, found.reading || '', found.pos || '', null, found.matchId || '');
        } else {
            ok = populateKanjiTooltip(found.word);
        }
        if (!ok) return;
        positionTooltip(found.el, boundingEl);
        tooltipFloorTop = Infinity; // reset floor for new target
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
 * @returns {{ type: 'word'|'kanji', key: string, el: HTMLElement, word?: string, reading?: string, pos?: string, matchId?: string }|null}
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
        const matchId = wordSpan.dataset.matchId || '';
        const hasMatches = Boolean(matchId && getStoredMatches(matchId));
        // Show tooltip for kanji words, or kana words with matches when setting enabled
        if (hasKanji || (nihongoSettings.kanaWordTooltips && hasMatches)) {
            const reading = wordSpan.dataset.reading || '';
            const pos = wordSpan.dataset.pos || '';
            // In search results, position tooltip relative to the card (not the word span)
            const searchCard = wordSpan.closest('.nihongo-search-card');
            const posEl = searchCard || wordSpan;
            return { type: 'word', key: `w:${word}:${matchId}`, el: posEl, word, reading, pos, matchId };
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
        // Capture surface text and context sentence while hoveredTarget is valid
        lastSurfaceText = getTextWithoutRuby(found.el);
        lastContextSentence = getContextSentence();
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

    const onWheel = (e) => {
        // Shift+Scroll on word span navigates tooltip pages
        if (!e.shiftKey || tooltipPages.length <= 1) return;
        const wordSpan = e.target instanceof HTMLElement && e.target.closest('.nihongo-word');
        if (!wordSpan || !currentKey) return;
        e.preventDefault();
        e.stopPropagation();
        showTooltipPage(currentPageIndex + (e.deltaY > 0 ? 1 : -1));
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    container.addEventListener('scroll', onScroll, true);
    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('mouseup', onMouseUp);
    container.addEventListener('wheel', onWheel, { passive: false });

    attachedContainers.set(container, { onMove, onLeave, onScroll, onMouseDown, onMouseUp, onWheel });
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
    if (handlers.onWheel) container.removeEventListener('wheel', handlers.onWheel);

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
    tooltipFloorTop = Infinity;
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
    const maxH = Math.min(window.innerHeight * 0.7, 500);
    tip.style.maxHeight = `${maxH}px`;

    const tipRect = tip.getBoundingClientRect();
    const gap = 8;
    let left = rect.left;
    let top = rect.bottom + gap;

    // If below goes off-screen, show above
    const tipHeight = tipRect.height || maxH;
    if (top + tipHeight > window.innerHeight) {
        top = rect.top - tipHeight - gap;
    }
    // Clamp to viewport
    if (top + tipHeight > window.innerHeight) {
        top = window.innerHeight - tipHeight - gap;
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
 * Handles mouseup inside chat.
 * If user selected Japanese text, looks it up in the dictionary and shows a tooltip.
 * Works in inspect mode, or when selectionLookup setting is enabled.
 * If user clicked without selecting, dismisses the selection tooltip.
 */
function onSelectionLookup() {
    // Only proceed if inspect mode or selectionLookup setting is active
    if (!inspectActive && !nihongoSettings.selectionLookup) return;
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

    // Hide any existing tooltip first
    hideTooltip();

    // Try dictionary lookup first (if available)
    let ok = false;
    if (isMeaningAvailable()) {
        const asHiragana = katakanaToHiragana(text);
        const lookupWord = (asHiragana !== text && !lookupMeaning(text) && lookupMeaning(asHiragana)) ? asHiragana : text;
        ok = populateWordTooltip(lookupWord, '', '');
    }

    // If no dictionary match, show a minimal tooltip with just chat action buttons
    if (!ok) {
        ok = showMinimalSelectionTooltip(text);
    }

    if (!ok) return;

    // Position near the selection
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    positionTooltipAtRect(rect);
    currentKey = `sel:${text}`;
    selectionState = { word: text };
}

/**
 * Shows a minimal tooltip with just the word and chat action buttons.
 * Used when no dictionary match is found for a selection.
 * @param {string} word
 * @returns {boolean}
 */
function showMinimalSelectionTooltip(word) {
    const tip = ensureTooltip();
    tooltipPages = [];
    currentPageIndex = 0;

    const html = `
        <div class="nihongo-tooltip-inner nihongo-wt-inner">
            <div class="nihongo-wt-word-section">
                <div class="nihongo-wt-word-top">
                    <span class="nihongo-wt-word">${word}</span>
                    <span class="nihongo-wt-header-actions">
                        <button class="nihongo-wt-header-btn nihongo-wt-btn-copy" title="Copy word" data-word="${word}"><i class="fa-solid fa-copy"></i></button>
                    </span>
                </div>
                <div class="nihongo-wt-meaning-placeholder">No definition found</div>
                <div class="nihongo-wt-chat-actions" data-word="${word}" data-reading="">
                    <button class="nihongo-wt-chat-btn" data-chat-action="explain" title="Explain this word"><i class="fa-solid fa-circle-question"></i> Explain</button>
                    <button class="nihongo-wt-chat-btn" data-chat-action="translate" title="Translate in context"><i class="fa-solid fa-language"></i> Translate</button>
                    <button class="nihongo-wt-chat-btn" data-chat-action="alternatives" title="Synonyms & alternatives"><i class="fa-solid fa-arrows-split-up-and-left"></i> Alternatives</button>
                    <button class="nihongo-wt-chat-btn" data-chat-action="grammar" title="Explain grammar"><i class="fa-solid fa-spell-check"></i> Grammar</button>
                </div>
            </div>
        </div>
    `;

    tooltipPages = [{ html, label: word, displayWord: word }];
    showTooltipPage(0);
    return true;
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

    // Selection lookup: only attach if persistent handler isn't already active
    if (!persistentSelectionHandler) {
        selectionHandler = () => onSelectionLookup();
        chat.addEventListener('mouseup', selectionHandler);

        resizeHandler = () => {
            if (selectionState) restoreSelectionTooltip();
        };
        window.addEventListener('resize', resizeHandler);
    }

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

/** @type {(() => void)|null} */
let persistentSelectionHandler = null;
/** @type {(() => void)|null} */
let persistentResizeHandler = null;

/**
 * Attaches a persistent mouseup handler on #chat for selection lookup.
 * This works independently of inspect mode — controlled by selectionLookup setting.
 * Call once during initialization.
 */
export function enableSelectionLookup() {
    const chat = document.getElementById('chat');
    if (!chat || persistentSelectionHandler) return;

    persistentSelectionHandler = () => onSelectionLookup();
    chat.addEventListener('mouseup', persistentSelectionHandler);

    persistentResizeHandler = () => {
        if (selectionState && !inspectActive) restoreSelectionTooltip();
    };
    window.addEventListener('resize', persistentResizeHandler);
}
