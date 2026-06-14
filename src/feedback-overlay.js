/**
 * Writing Feedback — inline overlay on sent messages.
 *
 * Renders anchored feedback issues as underlines directly over the Japanese in a
 * rendered message (`.mes_text`), with a click-to-open popover per span. Also
 * owns the per-message "session": the reversible staging state for in-place
 * fixes, a live preview, and the single commit.
 *
 * ── Why search-by-quote instead of the stored anchor offsets ──
 * The issue anchors are computed against the raw `message.mes`. The rendered
 * `.mes_text` differs from that source: markdown transforms characters, and the
 * furigana hook injects `<rt>` reading text that is NOT in the source. So we map
 * a span by **searching for the exact quote (occurrence-aware) in the rendered
 * text while ignoring ruby readings**, then wrap the covered text-node segments.
 * Quotes that can't be located are silently skipped — the card still lists them.
 *
 * ── Why click (not hover) opens the popover ──
 * A mark contains `.nihongo-word` spans, so a hover popover would fight the
 * inspect-mode word tooltip on the same pixels. Click sidesteps that entirely;
 * opening the popover also dismisses any lingering hover tooltip.
 */

import { applyStagedFixes, getCategory, SEVERITY, isIssueSafeToApply } from './feedback-schema.js';
import { renderFormatted, buildStageToggle } from './feedback-render.js';
import { hideKanjiTooltip } from './kanji-tooltip.js';

const MARK_CLASS = 'nihongo-fb-mark';

// ===== Session =====

/**
 * @typedef {Object} FeedbackSession
 * @property {import('./feedback-schema.js').FeedbackResult} result
 * @property {boolean} applyAllowed     - Whether in-place apply (staging) is offered.
 * @property {boolean} inlineToggleable - Whether the per-message inline toggle is shown.
 * @property {(fn: () => void) => (() => void)} subscribe
 * @property {(issue: any) => boolean} isStaged
 * @property {(issue: any) => void} toggleStage
 * @property {() => boolean} isRevisedStaged
 * @property {() => void} toggleRevised
 * @property {() => void} clearStaging
 * @property {() => any[]} stagedIssues
 * @property {() => number} stagedCount
 * @property {() => boolean} hasStaged
 * @property {() => string} previewText
 * @property {() => Promise<void>} commit
 * @property {boolean} inlineVisible
 * @property {(v: boolean) => void} setInlineVisible
 * @property {() => void} toggleInline
 */

/**
 * Creates the per-message feedback session. Pure state + a tiny pub/sub; the
 * card and the overlay both subscribe and re-render on change.
 *
 * @param {Object} opts
 * @param {import('./feedback-schema.js').FeedbackResult} opts.result
 * @param {() => string} opts.getSourceText   - Returns the current message text the anchors apply to.
 * @param {boolean} opts.applyAllowed
 * @param {boolean} opts.inlineToggleable
 * @param {boolean} opts.initialInlineVisible
 * @param {(text: string) => Promise<void>} opts.onCommit  - Writes the committed text to the message.
 * @returns {FeedbackSession}
 */
export function createFeedbackSession(opts) {
    const { result, getSourceText, applyAllowed, inlineToggleable, initialInlineVisible, onCommit } = opts;
    /** @type {Set<any>} */
    const staged = new Set();
    let revisedStaged = false;
    let inlineVisible = Boolean(initialInlineVisible);
    /** @type {Set<() => void>} */
    const subs = new Set();

    function notify() {
        for (const fn of [...subs]) {
            try { fn(); } catch (err) { console.error('[NihongoHelper:Feedback] session subscriber error', err); }
        }
    }

    const session = /** @type {FeedbackSession} */ ({
        result,
        applyAllowed: Boolean(applyAllowed),
        inlineToggleable: Boolean(inlineToggleable),

        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

        // ── Staging ──
        isStaged: (issue) => staged.has(issue),
        toggleStage(issue) {
            if (staged.has(issue)) {
                staged.delete(issue);
            } else {
                staged.add(issue);
                revisedStaged = false; // individual fixes and the full revision are mutually exclusive
            }
            notify();
        },
        isRevisedStaged: () => revisedStaged,
        toggleRevised() {
            revisedStaged = !revisedStaged;
            if (revisedStaged) staged.clear();
            notify();
        },
        clearStaging() {
            if (!staged.size && !revisedStaged) return;
            staged.clear();
            revisedStaged = false;
            notify();
        },
        stagedIssues: () => [...staged],
        stagedCount: () => (revisedStaged ? 1 : staged.size),
        hasStaged: () => revisedStaged || staged.size > 0,

        previewText() {
            const src = getSourceText() || '';
            if (revisedStaged && result.revisedText) return result.revisedText;
            return applyStagedFixes(src, [...staged]).text;
        },

        async commit() {
            if (!session.hasStaged()) return;
            const text = session.previewText();
            await onCommit(text);
        },

        // ── Inline visibility ──
        get inlineVisible() { return inlineVisible; },
        setInlineVisible(v) {
            v = Boolean(v);
            if (inlineVisible === v) return;
            inlineVisible = v;
            notify();
        },
        toggleInline() { session.setInlineVisible(!inlineVisible); },
    });

    return session;
}

// ===== Overlay state application =====

/**
 * Brings the message's inline marks in line with the session + staleness:
 * renders marks when visible & fresh, updates staged styling in place when they
 * already exist (so an open popover survives), or clears them otherwise.
 *
 * @param {HTMLElement|null} mesEl
 * @param {FeedbackSession} session
 * @param {{stale?: boolean}} [opts]
 */
export function applyOverlayState(mesEl, session, opts = {}) {
    if (!mesEl) return;
    const mesText = mesEl.querySelector('.mes_text');
    if (!mesText) return;

    if (session.inlineVisible && !opts.stale) {
        if (mesText.querySelector(`.${MARK_CLASS}`)) {
            updateMarkStaging(mesEl, session);
        } else {
            renderInlineMarks(mesEl, session);
        }
    } else {
        clearInlineMarks(mesEl);
    }
}

/**
 * Wraps each locatable issue quote in `.mes_text` with a mark span. Existing
 * marks are cleared first. Non-overlapping spans only (earliest-start wins).
 * @param {HTMLElement} mesEl
 * @param {FeedbackSession} session
 */
export function renderInlineMarks(mesEl, session) {
    const mesText = mesEl?.querySelector('.mes_text');
    if (!mesText) return;
    clearInlineMarks(mesEl);

    const issues = (session.result?.issues || []).filter(it => it && it.quote);
    if (!issues.length) return;

    // Resolve a span (in rendered-text coordinates) for each issue once.
    const map0 = buildTextMap(mesText);
    const spans = [];
    for (const issue of issues) {
        const off = findOffsets(map0, issue.quote, issue.occurrence);
        if (off) spans.push({ issue, start: off.start, end: off.end });
    }

    // Greedily keep non-overlapping spans (earliest start, then shortest).
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    const accepted = [];
    let lastEnd = -1;
    for (const s of spans) {
        if (s.start < lastEnd) continue;
        accepted.push(s);
        lastEnd = s.end;
    }

    // Wrap each accepted span. Rebuild the map per issue: wrapping never changes
    // the text content (only node boundaries), so the offsets stay valid.
    for (const s of accepted) {
        const map = buildTextMap(mesText);
        wrapOffsets(map, s.start, s.end, () => makeMark(s.issue, session));
    }
}

/**
 * Removes all inline marks from a message, restoring the original text nodes.
 * @param {HTMLElement} mesEl
 */
export function clearInlineMarks(mesEl) {
    const mesText = mesEl?.querySelector('.mes_text');
    if (!mesText) return;
    const marks = mesText.querySelectorAll(`.${MARK_CLASS}`);
    for (const mark of marks) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
    }
    if (marks.length) mesText.normalize();
    if (popoverAnchor && !document.body.contains(popoverAnchor)) closeFeedbackPopover();
}

/**
 * Toggles the staged styling on existing marks in place (no DOM rebuild), so an
 * open popover and its anchor span survive a staging change.
 * @param {HTMLElement} mesEl
 * @param {FeedbackSession} session
 */
export function updateMarkStaging(mesEl, session) {
    const mesText = mesEl?.querySelector('.mes_text');
    if (!mesText) return;
    for (const mark of mesText.querySelectorAll(`.${MARK_CLASS}`)) {
        const idx = Number(mark.getAttribute('data-fb-issue'));
        const issue = session.result?.issues?.[idx];
        const staged = Boolean(session.applyAllowed && issue && session.isStaged(issue));
        mark.classList.toggle('nihongo-fb-mark-staged', staged);
    }
}

// ===== Mark creation =====

/**
 * @param {any} issue
 * @param {FeedbackSession} session
 * @returns {HTMLElement}
 */
function makeMark(issue, session) {
    const span = document.createElement('span');
    span.className = `${MARK_CLASS} nihongo-fb-mark-sev-${issue.severity}`;
    const idx = session.result?.issues?.indexOf(issue) ?? -1;
    span.setAttribute('data-fb-issue', String(idx));
    if (session.applyAllowed && session.isStaged(issue)) span.classList.add('nihongo-fb-mark-staged');
    span.addEventListener('click', (e) => {
        // Never hijack an active text selection.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        e.preventDefault();
        e.stopPropagation();
        hideKanjiTooltip();
        openFeedbackPopover(span, issue, session);
    });
    return span;
}

// ===== Text ↔ DOM mapping (ruby-aware) =====

/**
 * Builds a map of `.mes_text`'s visible text (ignoring `<rt>`/`<rp>` ruby
 * readings) to its backing text nodes.
 * @param {HTMLElement} root
 * @returns {{ text: string, segments: Array<{node: Text, start: number, end: number}> }}
 */
function buildTextMap(root) {
    const segments = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.parentElement && node.parentElement.closest('rt, rp')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let n;
    while ((n = walker.nextNode())) {
        const start = text.length;
        text += n.nodeValue || '';
        segments.push({ node: /** @type {Text} */ (n), start, end: text.length });
    }
    return { text, segments };
}

/**
 * Finds the [start, end) offsets of the Nth (1-based) occurrence of `quote`.
 * @returns {{start: number, end: number}|null}
 */
function findOffsets(map, quote, occurrence) {
    if (!quote) return null;
    const target = Math.max(1, Math.floor(occurrence || 1));
    let from = 0;
    let count = 0;
    while (true) {
        const i = map.text.indexOf(quote, from);
        if (i === -1) return null;
        count++;
        if (count === target) return { start: i, end: i + quote.length };
        from = i + quote.length;
    }
}

/**
 * Wraps the text covering [startG, endG) (global offsets) in wrapper elements,
 * splitting text nodes at the boundaries. Multiple wrappers result when the
 * span crosses inline element boundaries (e.g. ruby base + following kana).
 * @param {{segments: Array<{node: Text, start: number, end: number}>}} map
 * @param {number} startG
 * @param {number} endG
 * @param {() => HTMLElement} makeWrapper
 */
function wrapOffsets(map, startG, endG, makeWrapper) {
    for (const seg of [...map.segments]) {
        if (seg.end <= startG || seg.start >= endG) continue;
        const localStart = Math.max(startG, seg.start) - seg.start;
        const localEnd = Math.min(endG, seg.end) - seg.start;
        if (localEnd <= localStart) continue;
        let node = seg.node;
        if (localStart > 0) node = node.splitText(localStart);
        if ((localEnd - localStart) < node.nodeValue.length) node.splitText(localEnd - localStart);
        const wrapper = makeWrapper();
        node.parentNode.insertBefore(wrapper, node);
        wrapper.appendChild(node);
    }
}

// ===== Popover (singleton) =====

/** @type {HTMLElement|null} */
let popoverEl = null;
/** @type {HTMLElement|null} */
let popoverAnchor = null;
/** @type {(() => void)|null} */
let popoverUnsub = null;
/** @type {{ click: (e: MouseEvent) => void, key: (e: KeyboardEvent) => void }|null} */
let popoverDocHandler = null;

function ensurePopover() {
    if (popoverEl && document.body.contains(popoverEl)) return popoverEl;
    popoverEl = document.createElement('div');
    popoverEl.className = 'nihongo-fb-popover';
    popoverEl.style.display = 'none';
    document.body.appendChild(popoverEl);
    return popoverEl;
}

/**
 * Opens the issue popover anchored to a mark span.
 * @param {HTMLElement} anchorEl
 * @param {any} issue
 * @param {FeedbackSession} session
 */
export function openFeedbackPopover(anchorEl, issue, session) {
    const pop = ensurePopover();
    popoverAnchor = anchorEl;
    renderPopoverContent(pop, issue, session);
    pop.style.display = '';
    positionPopover(pop, anchorEl);

    if (popoverUnsub) popoverUnsub();
    popoverUnsub = session.subscribe(() => {
        if (popoverAnchor && document.body.contains(popoverAnchor)) {
            renderPopoverContent(pop, issue, session);
            positionPopover(pop, popoverAnchor);
        } else {
            closeFeedbackPopover();
        }
    });

    if (!popoverDocHandler) {
        popoverDocHandler = {
            click: (e) => {
                if (popoverEl && popoverEl.contains(/** @type {Node} */ (e.target))) return;
                if (e.target instanceof HTMLElement && e.target.closest(`.${MARK_CLASS}`)) return;
                closeFeedbackPopover();
            },
            key: (e) => { if (e.key === 'Escape') closeFeedbackPopover(); },
        };
    }
    document.removeEventListener('mousedown', popoverDocHandler.click, true);
    document.removeEventListener('keydown', popoverDocHandler.key, true);
    // Defer binding so the click that opened the popover doesn't instantly close it.
    setTimeout(() => {
        if (!popoverDocHandler) return;
        document.addEventListener('mousedown', popoverDocHandler.click, true);
        document.addEventListener('keydown', popoverDocHandler.key, true);
    }, 0);
}

/** Closes the issue popover and detaches its listeners. */
export function closeFeedbackPopover() {
    if (popoverUnsub) { popoverUnsub(); popoverUnsub = null; }
    if (popoverDocHandler) {
        document.removeEventListener('mousedown', popoverDocHandler.click, true);
        document.removeEventListener('keydown', popoverDocHandler.key, true);
    }
    popoverAnchor = null;
    if (popoverEl) popoverEl.style.display = 'none';
}

/**
 * @param {HTMLElement} pop
 * @param {any} issue
 * @param {FeedbackSession} session
 */
function renderPopoverContent(pop, issue, session) {
    const cat = getCategory(issue.category);
    const sev = SEVERITY[issue.severity] || SEVERITY.minor;
    pop.replaceChildren();

    // Header: category + severity + close.
    const head = document.createElement('div');
    head.className = 'nihongo-fb-popover-head';

    const catChip = document.createElement('span');
    catChip.className = 'nihongo-fb-chip nihongo-fb-cat';
    catChip.innerHTML = `<i class="fa-solid ${cat.icon}"></i> `;
    catChip.appendChild(document.createTextNode(cat.label));

    const sevChip = document.createElement('span');
    sevChip.className = `nihongo-fb-badge nihongo-fb-sev-${issue.severity}`;
    sevChip.innerHTML = `<i class="fa-solid ${sev.icon}"></i> `;
    sevChip.appendChild(document.createTextNode(sev.label));

    const close = document.createElement('button');
    close.className = 'nihongo-fb-popover-close';
    close.title = 'Close';
    close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    close.addEventListener('click', () => closeFeedbackPopover());

    head.append(catChip, sevChip, close);
    pop.appendChild(head);

    // Quote → replacement.
    if (issue.quote || issue.replacement) {
        const change = document.createElement('div');
        change.className = 'nihongo-fb-change';
        if (issue.quote) {
            const q = document.createElement('span');
            q.className = 'nihongo-fb-quote nihongo-fb-jp';
            renderFormatted(q, issue.quote, { inline: true });
            change.appendChild(q);
        }
        if (issue.replacement) {
            const arrow = document.createElement('i');
            arrow.className = 'fa-solid fa-arrow-right nihongo-fb-arrow';
            const r = document.createElement('span');
            r.className = 'nihongo-fb-replacement nihongo-fb-jp';
            renderFormatted(r, issue.replacement, { inline: true });
            change.append(arrow, r);
        }
        pop.appendChild(change);
    }

    // Explanation (English).
    if (issue.explanation) {
        const exp = document.createElement('div');
        exp.className = 'nihongo-fb-issue-exp';
        renderFormatted(exp, issue.explanation);
        pop.appendChild(exp);
    }

    // Stage toggle — only when in-place apply is allowed and the fix is safe.
    if (session.applyAllowed && isIssueSafeToApply(issue)) {
        const actions = document.createElement('div');
        actions.className = 'nihongo-fb-popover-actions';
        actions.appendChild(buildStageToggle(issue, session));
        pop.appendChild(actions);
    }
}

/**
 * @param {HTMLElement} pop
 * @param {HTMLElement} anchor
 */
function positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.visibility = 'hidden';
    pop.style.left = '0px';
    pop.style.top = '0px';

    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    let left = rect.left;
    if (left + pw > vw - margin) left = vw - margin - pw;
    if (left < margin) left = margin;

    let top = rect.bottom + 6;
    if (top + ph > vh - margin) {
        const above = rect.top - 6 - ph;
        top = above >= margin ? above : Math.max(margin, vh - margin - ph);
    }

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.visibility = '';
}
