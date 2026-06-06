/**
 * Writing Feedback — shared renderer.
 *
 * Builds the feedback UI used by BOTH entry points (the card attached beneath a
 * sent message and the draft-review modal). A card is a small state machine
 * with `loading` / `error` / `ready` phases; callers swap phases as the request
 * progresses. The body builders (`buildResultView`, `buildIssueCard`) are also
 * exported so the modal can reuse them directly.
 *
 * All model-supplied text is inserted via `textContent` (never innerHTML), so
 * hostile content in a reviewed message cannot inject markup.
 */

import { getCategory, SEVERITY, CONFIDENCE, isIssueSafeToApply } from './feedback-schema.js';

const CARD_ICON = 'fa-comment-dots';

/**
 * @typedef {Object} FeedbackCardCallbacks
 * @property {() => void} [onRegenerate]
 * @property {() => void} [onRemove]
 * @property {() => void} [onRetry]
 * @property {(text: string) => void} [onApplyRevised]  - Apply full revised text.
 * @property {(issue: import('./feedback-schema.js').FeedbackIssue) => void} [onApplyIssue] - Apply one fix.
 *
 * @typedef {Object} FeedbackCardOptions
 * @property {'attached'|'modal'} [mode='attached']
 * @property {boolean} [expanded=false]   - Initial expanded state (attached mode).
 * @property {boolean} [showApply=false]  - Show "apply" affordances (modal mode).
 * @property {FeedbackCardCallbacks} [callbacks]
 *
 * @typedef {Object} FeedbackCard
 * @property {HTMLElement} element
 * @property {(reasoning?: string) => void} setLoading
 * @property {(error: string, raw?: string) => void} setError
 * @property {(result: import('./feedback-schema.js').FeedbackResult, opts?: {stale?: boolean, meta?: any}) => void} setResult
 * @property {(stale: boolean) => void} setStale
 * @property {() => boolean} isExpanded
 * @property {(expanded: boolean) => void} setExpanded
 */

/**
 * Creates a feedback card component.
 * @param {FeedbackCardOptions} [options]
 * @returns {FeedbackCard}
 */
export function createFeedbackCard(options = {}) {
    const mode = options.mode || 'attached';
    const callbacks = options.callbacks || {};
    let expanded = mode === 'modal' ? true : Boolean(options.expanded);
    /** @type {import('./feedback-schema.js').FeedbackResult|null} */
    let currentResult = null;

    const element = document.createElement('div');
    element.className = `nihongo-feedback-card nihongo-fb-mode-${mode}`;

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'nihongo-fb-header';

    const headerIcon = document.createElement('i');
    headerIcon.className = `fa-solid ${CARD_ICON} nihongo-fb-header-icon`;

    const title = document.createElement('span');
    title.className = 'nihongo-fb-title';
    title.textContent = 'Japanese Feedback';

    const badges = document.createElement('span');
    badges.className = 'nihongo-fb-badges';

    const actions = document.createElement('span');
    actions.className = 'nihongo-fb-header-actions';

    header.append(headerIcon, title, badges, actions);

    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-down nihongo-fb-chevron';

    if (mode === 'attached') {
        header.appendChild(chevron);
        header.classList.add('nihongo-fb-clickable');
        header.addEventListener('click', (e) => {
            // Don't toggle when clicking an action button in the header.
            if (e.target instanceof HTMLElement && e.target.closest('.nihongo-fb-icon-btn')) return;
            setExpanded(!expanded);
        });

        // Header action buttons (regenerate / remove).
        if (callbacks.onRegenerate) {
            actions.appendChild(iconButton('fa-rotate', 'Regenerate feedback', (e) => {
                e.stopPropagation();
                callbacks.onRegenerate();
            }));
        }
        if (callbacks.onRemove) {
            actions.appendChild(iconButton('fa-trash-can', 'Remove feedback', (e) => {
                e.stopPropagation();
                callbacks.onRemove();
            }));
        }
    }

    // ── Body ──
    const body = document.createElement('div');
    body.className = 'nihongo-fb-body';

    element.append(header, body);
    applyExpanded();

    // ── State setters ──
    function setLoading(reasoning) {
        currentResult = null;
        element.classList.remove('nihongo-fb-has-error', 'nihongo-fb-stale');
        element.classList.add('nihongo-fb-loading');
        renderBadges({ phase: 'loading' });
        body.replaceChildren(buildLoadingView(reasoning));
        // Note: we intentionally do NOT force-expand here. Manual runs are
        // created already-expanded; automatic runs stay collapsed/unobtrusive.
    }

    function setError(error, raw) {
        currentResult = null;
        element.classList.remove('nihongo-fb-loading', 'nihongo-fb-stale');
        element.classList.add('nihongo-fb-has-error');
        renderBadges({ phase: 'error' });
        body.replaceChildren(buildErrorView(error, raw, callbacks));
        if (mode === 'attached') setExpanded(true);
    }

    function setResult(result, opts = {}) {
        currentResult = result;
        element.classList.remove('nihongo-fb-loading', 'nihongo-fb-has-error');
        element.classList.toggle('nihongo-fb-stale', Boolean(opts.stale));
        renderBadges({ phase: 'ready', result, stale: opts.stale });
        body.replaceChildren(buildResultView(result, {
            stale: opts.stale,
            showApply: Boolean(options.showApply),
            callbacks,
        }));
    }

    function setStale(stale) {
        element.classList.toggle('nihongo-fb-stale', Boolean(stale));
        if (currentResult) renderBadges({ phase: 'ready', result: currentResult, stale });
    }

    function renderBadges(state) {
        badges.replaceChildren();
        if (state.phase === 'loading') {
            badges.appendChild(makeBadge('Analyzing…', 'nihongo-fb-badge-loading', 'fa-spinner fa-spin-pulse'));
            return;
        }
        if (state.phase === 'error') {
            badges.appendChild(makeBadge('Error', 'nihongo-fb-badge-error', 'fa-triangle-exclamation'));
            return;
        }
        const result = state.result;
        const count = result.issueCount;
        if (state.stale) {
            badges.appendChild(makeBadge('Stale', 'nihongo-fb-badge-stale', 'fa-clock-rotate-left'));
        }
        if (count === 0) {
            badges.appendChild(makeBadge('No issues', 'nihongo-fb-sev-none', 'fa-circle-check'));
        } else {
            badges.appendChild(makeBadge(`${count} issue${count === 1 ? '' : 's'}`, 'nihongo-fb-badge-count'));
            if (result.highestSeverity) {
                const sev = SEVERITY[result.highestSeverity];
                badges.appendChild(makeBadge(sev.label, `nihongo-fb-sev-${result.highestSeverity}`, sev.icon));
            }
        }
    }

    function setExpanded(next) {
        expanded = next;
        applyExpanded();
    }
    function applyExpanded() {
        element.classList.toggle('nihongo-fb-expanded', expanded);
        element.classList.toggle('nihongo-fb-collapsed', !expanded);
    }

    return {
        element,
        setLoading,
        setError,
        setResult,
        setStale,
        isExpanded: () => expanded,
        setExpanded,
    };
}

// ===== Exported body builders (reused by the modal) =====

/**
 * Builds the full result body: summary, strengths, revised text, and issues.
 * @param {import('./feedback-schema.js').FeedbackResult} result
 * @param {{stale?: boolean, showApply?: boolean, callbacks?: FeedbackCardCallbacks}} [opts]
 * @returns {HTMLElement}
 */
export function buildResultView(result, opts = {}) {
    const { stale = false, showApply = false, callbacks = {} } = opts;
    const view = document.createElement('div');
    view.className = 'nihongo-fb-result';

    if (stale) {
        const note = document.createElement('div');
        note.className = 'nihongo-fb-stale-note';
        note.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> ';
        note.appendChild(document.createTextNode(
            'This message was edited after the feedback was generated. Regenerate for up-to-date feedback.'));
        view.appendChild(note);
    }

    if (result.summary) {
        const summary = document.createElement('div');
        summary.className = 'nihongo-fb-summary';
        summary.textContent = result.summary;
        view.appendChild(summary);
    }

    if (result.strengths?.length) {
        view.appendChild(buildSection('Strengths', 'fa-thumbs-up', result.strengths.map(buildStrengthItem)));
    }

    if (result.revisedText) {
        view.appendChild(buildRevisedBlock(result.revisedText, { showApply, onApply: callbacks.onApplyRevised }));
    }

    if (result.issues?.length) {
        const issueEls = result.issues.map(issue => buildIssueCard(issue, { showApply, onApplyIssue: callbacks.onApplyIssue }));
        view.appendChild(buildSection(`Issues (${result.issues.length})`, 'fa-list-check', issueEls));
    } else {
        const ok = document.createElement('div');
        ok.className = 'nihongo-fb-noissues';
        ok.innerHTML = '<i class="fa-solid fa-circle-check"></i> ';
        ok.appendChild(document.createTextNode('No issues found — this reads well.'));
        view.appendChild(ok);
    }

    return view;
}

/**
 * Builds a single issue card.
 * @param {import('./feedback-schema.js').FeedbackIssue} issue
 * @param {{showApply?: boolean, onApplyIssue?: (issue: any) => void}} [opts]
 * @returns {HTMLElement}
 */
export function buildIssueCard(issue, opts = {}) {
    const cat = getCategory(issue.category);
    const sev = SEVERITY[issue.severity] || SEVERITY.minor;
    const conf = CONFIDENCE[issue.confidence] || CONFIDENCE.medium;

    const card = document.createElement('div');
    card.className = `nihongo-fb-issue nihongo-fb-sev-border-${issue.severity}`;

    // Header row: category + severity + confidence.
    const head = document.createElement('div');
    head.className = 'nihongo-fb-issue-head';

    const catChip = document.createElement('span');
    catChip.className = 'nihongo-fb-chip nihongo-fb-cat';
    catChip.title = cat.description;
    catChip.innerHTML = `<i class="fa-solid ${cat.icon}"></i> `;
    catChip.appendChild(document.createTextNode(cat.label));

    const sevChip = makeBadge(sev.label, `nihongo-fb-sev-${issue.severity}`, sev.icon);
    sevChip.title = sev.description;

    const confChip = document.createElement('span');
    confChip.className = `nihongo-fb-chip nihongo-fb-conf nihongo-fb-conf-${issue.confidence}`;
    confChip.title = `Confidence: ${conf.description}`;
    confChip.textContent = `${conf.label} confidence`;

    head.append(catChip, sevChip, confChip);
    card.appendChild(head);

    // Quote → replacement row.
    if (issue.quote || issue.replacement) {
        const change = document.createElement('div');
        change.className = 'nihongo-fb-change';
        if (issue.quote) {
            const q = document.createElement('span');
            q.className = 'nihongo-fb-quote nihongo-fb-jp';
            q.textContent = issue.quote;
            change.appendChild(q);
            if (issue.anchor && !issue.anchor.found) {
                const warn = document.createElement('i');
                warn.className = 'fa-solid fa-link-slash nihongo-fb-anchor-warn';
                warn.title = 'This quote could not be located exactly in the original text.';
                change.appendChild(warn);
            }
        }
        if (issue.replacement) {
            const arrow = document.createElement('i');
            arrow.className = 'fa-solid fa-arrow-right nihongo-fb-arrow';
            const r = document.createElement('span');
            r.className = 'nihongo-fb-replacement nihongo-fb-jp';
            r.textContent = issue.replacement;
            change.append(arrow, r);
        }
        card.appendChild(change);
    }

    if (issue.explanation) {
        const exp = document.createElement('div');
        exp.className = 'nihongo-fb-issue-exp';
        exp.textContent = issue.explanation;
        card.appendChild(exp);
    }

    if (issue.alternatives?.length) {
        const alts = document.createElement('div');
        alts.className = 'nihongo-fb-alts';
        const label = document.createElement('span');
        label.className = 'nihongo-fb-alts-label';
        label.textContent = 'Alternatives: ';
        alts.appendChild(label);
        issue.alternatives.forEach((alt, i) => {
            if (i > 0) alts.appendChild(document.createTextNode(' · '));
            const a = document.createElement('span');
            a.className = 'nihongo-fb-alt nihongo-fb-jp';
            a.textContent = alt;
            alts.appendChild(a);
        });
        card.appendChild(alts);
    }

    // Per-issue apply (modal only). Disabled when the anchor isn't safe.
    if (opts.showApply && opts.onApplyIssue && issue.replacement) {
        const safe = isIssueSafeToApply(issue);
        const applyBtn = document.createElement('button');
        applyBtn.className = 'menu_button menu_button_icon nihongo-fb-apply-issue';
        applyBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> ';
        applyBtn.appendChild(document.createTextNode('Apply fix'));
        if (!safe) {
            applyBtn.disabled = true;
            applyBtn.title = 'Cannot safely apply: the quote is ambiguous or could not be located.';
        } else {
            applyBtn.addEventListener('click', () => opts.onApplyIssue(issue));
        }
        card.appendChild(applyBtn);
    }

    return card;
}

// ===== Internal builders =====

function buildLoadingView(reasoning) {
    const wrap = document.createElement('div');
    wrap.className = 'nihongo-fb-loading-view';

    const status = document.createElement('div');
    status.className = 'nihongo-fb-status';
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin-pulse"></i> ';
    status.appendChild(document.createTextNode('Analyzing Japanese…'));
    wrap.appendChild(status);

    if (reasoning) {
        const r = document.createElement('div');
        r.className = 'nihongo-fb-reasoning';
        r.textContent = reasoning;
        wrap.appendChild(r);
    }
    return wrap;
}

function buildErrorView(error, raw, callbacks) {
    const wrap = document.createElement('div');
    wrap.className = 'nihongo-fb-error-view';

    const msg = document.createElement('div');
    msg.className = 'nihongo-fb-error-msg';
    msg.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ';
    msg.appendChild(document.createTextNode(error || 'Feedback failed.'));
    wrap.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'nihongo-fb-error-actions';
    if (callbacks.onRetry) {
        const retry = document.createElement('button');
        retry.className = 'menu_button menu_button_icon';
        retry.innerHTML = '<i class="fa-solid fa-rotate"></i> ';
        retry.appendChild(document.createTextNode('Retry'));
        retry.addEventListener('click', () => callbacks.onRetry());
        actions.appendChild(retry);
    }
    wrap.appendChild(actions);

    if (raw) {
        const details = document.createElement('details');
        details.className = 'nihongo-fb-raw';
        const summary = document.createElement('summary');
        summary.textContent = 'Show raw model output';
        const pre = document.createElement('pre');
        pre.textContent = raw;
        details.append(summary, pre);
        wrap.appendChild(details);
    }
    return wrap;
}

function buildSection(titleText, icon, children) {
    const section = document.createElement('div');
    section.className = 'nihongo-fb-section';

    const title = document.createElement('div');
    title.className = 'nihongo-fb-section-title';
    title.innerHTML = `<i class="fa-solid ${icon}"></i> `;
    title.appendChild(document.createTextNode(titleText));
    section.appendChild(title);

    const list = document.createElement('div');
    list.className = 'nihongo-fb-section-body';
    for (const child of children) list.appendChild(child);
    section.appendChild(list);
    return section;
}

function buildStrengthItem(strength) {
    const item = document.createElement('div');
    item.className = 'nihongo-fb-strength';
    if (strength.quote) {
        const q = document.createElement('span');
        q.className = 'nihongo-fb-quote nihongo-fb-jp';
        q.textContent = strength.quote;
        item.appendChild(q);
    }
    if (strength.explanation) {
        const e = document.createElement('span');
        e.className = 'nihongo-fb-strength-exp';
        e.textContent = strength.quote ? ` — ${strength.explanation}` : strength.explanation;
        item.appendChild(e);
    }
    return item;
}

function buildRevisedBlock(text, { showApply, onApply } = {}) {
    const block = document.createElement('div');
    block.className = 'nihongo-fb-section nihongo-fb-revised';

    const title = document.createElement('div');
    title.className = 'nihongo-fb-section-title';
    title.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> ';
    title.appendChild(document.createTextNode('Suggested revision'));
    block.appendChild(title);

    const textEl = document.createElement('div');
    textEl.className = 'nihongo-fb-revised-text nihongo-fb-jp';
    textEl.textContent = text;
    block.appendChild(textEl);

    const actions = document.createElement('div');
    actions.className = 'nihongo-fb-revised-actions';
    actions.appendChild(iconTextButton('fa-copy', 'Copy', () => copyToClipboard(text)));
    if (showApply && onApply) {
        const applyBtn = document.createElement('button');
        applyBtn.className = 'menu_button menu_button_icon nihongo-fb-apply-revised';
        applyBtn.innerHTML = '<i class="fa-solid fa-arrow-down-to-line"></i> ';
        applyBtn.appendChild(document.createTextNode('Use this revision'));
        applyBtn.addEventListener('click', () => onApply(text));
        actions.appendChild(applyBtn);
    }
    block.appendChild(actions);
    return block;
}

// ===== Small DOM helpers =====

function makeBadge(text, className, icon) {
    const badge = document.createElement('span');
    badge.className = `nihongo-fb-badge ${className || ''}`.trim();
    if (icon) {
        badge.innerHTML = `<i class="fa-solid ${icon}"></i> `;
    }
    badge.appendChild(document.createTextNode(text));
    return badge;
}

function iconButton(icon, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'nihongo-fb-icon-btn';
    btn.title = title;
    btn.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    btn.addEventListener('click', onClick);
    return btn;
}

function iconTextButton(icon, text, onClick) {
    const btn = document.createElement('button');
    btn.className = 'menu_button menu_button_icon nihongo-fb-text-btn';
    btn.innerHTML = `<i class="fa-solid ${icon}"></i> `;
    btn.appendChild(document.createTextNode(text));
    btn.addEventListener('click', onClick);
    return btn;
}

function copyToClipboard(text) {
    try {
        navigator.clipboard?.writeText(text);
        if (typeof toastr !== 'undefined') toastr.info('Copied to clipboard.');
    } catch { /* ignore */ }
}
