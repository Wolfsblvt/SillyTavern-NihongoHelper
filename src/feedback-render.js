/**
 * Writing Feedback — shared renderer.
 *
 * Builds the feedback UI used by BOTH entry points (the card attached beneath a
 * sent message and the draft-review modal). A card is a small state machine
 * with `loading` / `error` / `ready` phases; callers swap phases as the request
 * progresses. The body builders (`buildResultView`, `buildIssueCard`) are also
 * exported so the modal can reuse them directly.
 *
 * Model-supplied text is rendered through SillyTavern's `messageFormatting`
 * pipeline (markdown + the registered furigana hook + DOMPurify sanitization),
 * so feedback gets the same automatic furigana and inspect-mode word tooltips
 * as the main chat, and hostile content is sanitized before insertion. Plain
 * UI labels still use `textContent`.
 */

import { messageFormatting } from '../../../../../script.js';
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
    /** Last streamed/known reasoning, carried from loading into the result view. */
    let lastReasoning = '';
    /** @type {HTMLElement|null} Live reasoning text element during streaming. */
    let loadingReasoningTextEl = null;
    /** @type {import('./feedback-overlay.js').FeedbackSession|null} */
    let currentSession = null;
    /** @type {(() => void)|null} */
    let sessionUnsub = null;
    /** Opts from the last setResult, so session-driven re-renders can reuse them. */
    let lastResultOpts = {};
    /** @type {HTMLElement|null} Header inline-highlights toggle button. */
    let inlineToggleBtn = null;

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

    // Staging tray host — kept OUTSIDE the collapsible body so the "Apply to
    // message" controls stay reachable while the card is collapsed (inline marks
    // + the popover let you stage fixes without ever expanding the card).
    const tray = document.createElement('div');
    tray.className = 'nihongo-fb-tray-host';

    element.append(header, body, tray);
    applyExpanded();

    // ── State setters ──
    function setLoading(reasoning) {
        currentResult = null;
        clearSession();
        element.classList.remove('nihongo-fb-has-error', 'nihongo-fb-stale');
        element.classList.add('nihongo-fb-loading');
        renderBadges({ phase: 'loading' });

        // Build the loading view once, then stream reasoning into it in place
        // (rebuilding per token would thrash the formatter and reset scroll).
        let view = body.querySelector('.nihongo-fb-loading-view');
        if (!view) {
            view = buildLoadingView();
            body.replaceChildren(view);
            loadingReasoningTextEl = view.querySelector('.nihongo-fb-reasoning-text');
        }
        if (reasoning) {
            lastReasoning = reasoning;
            view.querySelector('.nihongo-fb-reasoning-block')?.classList.remove('nihongo-fb-hidden');
            if (loadingReasoningTextEl) {
                renderFormatted(loadingReasoningTextEl, reasoning, { reasoning: true });
                loadingReasoningTextEl.scrollTop = loadingReasoningTextEl.scrollHeight;
            }
        }
        // Note: we intentionally do NOT force-expand here. Manual runs are
        // created already-expanded; automatic runs stay collapsed/unobtrusive.
    }

    function setError(error, raw) {
        currentResult = null;
        clearSession();
        loadingReasoningTextEl = null;
        element.classList.remove('nihongo-fb-loading', 'nihongo-fb-stale');
        element.classList.add('nihongo-fb-has-error');
        renderBadges({ phase: 'error' });
        body.replaceChildren(buildErrorView(error, raw, callbacks));
        if (mode === 'attached') setExpanded(true);
    }

    function setResult(result, opts = {}) {
        currentResult = result;
        loadingReasoningTextEl = null;
        element.classList.remove('nihongo-fb-loading', 'nihongo-fb-has-error');
        element.classList.toggle('nihongo-fb-stale', Boolean(opts.stale));

        // (Re)bind the session that drives staging + inline highlights; the card
        // re-renders its body and inline toggle whenever the session changes.
        clearSession();
        if (opts.session) {
            currentSession = opts.session;
            sessionUnsub = currentSession.subscribe(() => { renderInlineToggle(); refreshResult(); });
        }
        lastResultOpts = {
            stale: opts.stale,
            // Prefer explicitly-supplied (persisted) reasoning, else this run's.
            reasoning: opts.reasoning ?? lastReasoning,
        };
        renderInlineToggle();
        refreshResult();
    }

    function refreshResult() {
        if (!currentResult) return;
        renderBadges({ phase: 'ready', result: currentResult, stale: lastResultOpts.stale });
        body.replaceChildren(buildResultView(currentResult, {
            stale: lastResultOpts.stale,
            showApply: Boolean(options.showApply),
            callbacks,
            reasoning: lastResultOpts.reasoning,
            session: currentSession,
        }));
        refreshTray();
    }

    /**
     * Rebuilds the always-visible staging tray (sits outside the collapsible
     * body). When collapsed we omit the empty-state hint and the live preview
     * to stay compact — only the Apply/Clear bar shows once fixes are staged.
     */
    function refreshTray() {
        tray.replaceChildren();
        const staging = (currentSession && currentSession.applyAllowed && !lastResultOpts.stale)
            ? currentSession : null;
        if (!staging || !currentResult) return;
        const hasStageable = Boolean(currentResult.revisedText)
            || currentResult.issues?.some(isIssueSafeToApply);
        if (!hasStageable) return;
        if (!expanded && !staging.hasStaged()) return;
        tray.appendChild(buildStagingTray(staging, { showPreview: expanded }));
    }

    function setStale(stale) {
        element.classList.toggle('nihongo-fb-stale', Boolean(stale));
        lastResultOpts.stale = Boolean(stale);
        if (currentResult) refreshResult();
    }

    function clearSession() {
        if (sessionUnsub) { sessionUnsub(); sessionUnsub = null; }
        currentSession = null;
        tray.replaceChildren();
        renderInlineToggle();
    }

    /** (Re)renders the header inline-highlights toggle from the current session. */
    function renderInlineToggle() {
        if (inlineToggleBtn) { inlineToggleBtn.remove(); inlineToggleBtn = null; }
        if (mode !== 'attached') return;
        const s = currentSession;
        if (!s || !s.inlineToggleable) return;
        const active = s.inlineVisible;
        inlineToggleBtn = iconButton('fa-highlighter', active ? 'Hide inline highlights' : 'Show inline highlights', (e) => {
            e.stopPropagation();
            s.toggleInline();
        });
        inlineToggleBtn.classList.add('nihongo-fb-inline-toggle');
        inlineToggleBtn.classList.toggle('nihongo-fb-inline-active', active);
        actions.insertBefore(inlineToggleBtn, actions.firstChild);
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
        // The tray's empty-hint + preview visibility depend on expanded state.
        refreshTray();
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
 * @param {{stale?: boolean, showApply?: boolean, callbacks?: FeedbackCardCallbacks, reasoning?: string, session?: import('./feedback-overlay.js').FeedbackSession}} [opts]
 * @returns {HTMLElement}
 */
export function buildResultView(result, opts = {}) {
    const { stale = false, showApply = false, callbacks = {}, reasoning = '', session = null } = opts;
    // In-place staging is offered only by the attached card (via a session),
    // never the modal, and never on stale feedback (anchors no longer match).
    const staging = (session && session.applyAllowed && !stale) ? session : null;
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

    // Reasoning, when present, sits at the top — collapsed now that the actual
    // feedback has rendered, but still expandable.
    if (reasoning && String(reasoning).trim()) {
        view.appendChild(buildReasoningBlock(reasoning, { collapsed: true }));
    }

    if (result.summary) {
        const summary = document.createElement('div');
        summary.className = 'nihongo-fb-summary';
        renderFormatted(summary, result.summary);
        view.appendChild(summary);
    }

    if (result.strengths?.length) {
        view.appendChild(buildSection('Strengths', 'fa-thumbs-up', result.strengths.map(buildStrengthItem)));
    }

    if (result.revisedText) {
        view.appendChild(buildRevisedBlock(result.revisedText, { showApply, onApply: callbacks.onApplyRevised, staging }));
    }

    if (result.issues?.length) {
        const issueEls = result.issues.map(issue => buildIssueCard(issue, { showApply, onApplyIssue: callbacks.onApplyIssue, staging }));
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
 * @param {{showApply?: boolean, onApplyIssue?: (issue: any) => void, staging?: import('./feedback-overlay.js').FeedbackSession}} [opts]
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
            renderFormatted(q, issue.quote, { inline: true });
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
            renderFormatted(r, issue.replacement, { inline: true });
            change.append(arrow, r);
        }
        card.appendChild(change);
    }

    if (issue.explanation) {
        const exp = document.createElement('div');
        exp.className = 'nihongo-fb-issue-exp';
        renderFormatted(exp, issue.explanation);
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
            renderFormatted(a, alt, { inline: true });
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

    // Per-issue staging (attached card). Only safe-anchored fixes can stage.
    if (opts.staging && isIssueSafeToApply(issue)) {
        card.appendChild(buildStageToggle(issue, opts.staging));
    }

    return card;
}

/**
 * Builds a reversible "Stage fix" toggle for an issue, shared by the issue card
 * and the inline popover. Reflects and drives the session's staging state.
 * @param {import('./feedback-schema.js').FeedbackIssue} issue
 * @param {import('./feedback-overlay.js').FeedbackSession} session
 * @returns {HTMLButtonElement}
 */
export function buildStageToggle(issue, session) {
    const staged = session.isStaged(issue);
    const btn = document.createElement('button');
    btn.className = `menu_button menu_button_icon nihongo-fb-stage-btn${staged ? ' nihongo-fb-staged' : ''}`;
    btn.innerHTML = `<i class="fa-solid ${staged ? 'fa-square-check' : 'fa-square'}"></i> `;
    btn.appendChild(document.createTextNode(staged ? 'Staged' : 'Stage fix'));
    btn.addEventListener('click', (e) => { e.stopPropagation(); session.toggleStage(issue); });
    return btn;
}

/**
 * Builds the staging tray: a status line, apply/clear actions, and (optionally)
 * a live preview of the resulting message text.
 * @param {import('./feedback-overlay.js').FeedbackSession} session
 * @param {{showPreview?: boolean}} [opts]
 * @returns {HTMLElement}
 */
function buildStagingTray(session, opts = {}) {
    const { showPreview = true } = opts;
    const tray = document.createElement('div');
    tray.className = 'nihongo-fb-staging-tray';

    const bar = document.createElement('div');
    bar.className = 'nihongo-fb-staging-bar';

    const info = document.createElement('span');
    info.className = 'nihongo-fb-staging-info';

    if (!session.hasStaged()) {
        tray.classList.add('nihongo-fb-staging-empty');
        info.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> ';
        info.appendChild(document.createTextNode('Stage fixes to apply them to your message.'));
        bar.appendChild(info);
        tray.appendChild(bar);
        return tray;
    }

    const count = session.stagedCount();
    info.innerHTML = '<i class="fa-solid fa-layer-group"></i> ';
    info.appendChild(document.createTextNode(
        session.isRevisedStaged() ? 'Full revision staged' : `${count} fix${count === 1 ? '' : 'es'} staged`));
    bar.appendChild(info);

    const applyBtn = document.createElement('button');
    applyBtn.className = 'menu_button menu_button_icon nihongo-fb-staging-apply';
    applyBtn.innerHTML = '<i class="fa-solid fa-arrow-down-to-line"></i> ';
    applyBtn.appendChild(document.createTextNode('Apply to message'));
    applyBtn.addEventListener('click', () => {
        applyBtn.disabled = true;
        Promise.resolve(session.commit()).catch((err) => {
            console.error('[NihongoHelper:Feedback] apply to message failed', err);
            applyBtn.disabled = false;
        });
    });
    bar.appendChild(applyBtn);
    bar.appendChild(iconTextButton('fa-xmark', 'Clear', () => session.clearStaging()));
    tray.appendChild(bar);

    if (showPreview) {
        const preview = document.createElement('div');
        preview.className = 'nihongo-fb-staging-preview nihongo-fb-jp';
        renderFormatted(preview, session.previewText());
        tray.appendChild(preview);
    }

    return tray;
}

// ===== Internal builders =====

function buildLoadingView() {
    const wrap = document.createElement('div');
    wrap.className = 'nihongo-fb-loading-view';

    const status = document.createElement('div');
    status.className = 'nihongo-fb-status';
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin-pulse"></i> ';
    status.appendChild(document.createTextNode('Analyzing Japanese…'));
    wrap.appendChild(status);

    // Pre-built reasoning block, expanded for live streaming and hidden until
    // the first reasoning token arrives (setLoading reveals + fills it).
    const reasoningBlock = buildReasoningBlock('', { collapsed: false, streaming: true });
    reasoningBlock.classList.add('nihongo-fb-hidden');
    wrap.appendChild(reasoningBlock);
    return wrap;
}

/**
 * Builds a collapsible reasoning block. Used both during streaming (expanded,
 * labelled "Thinking…") and in the finished result (collapsed, "Reasoning").
 * @param {string} reasoning
 * @param {{collapsed?: boolean, streaming?: boolean}} [opts]
 * @returns {HTMLElement}
 */
function buildReasoningBlock(reasoning, opts = {}) {
    const { collapsed = true, streaming = false } = opts;
    const block = document.createElement('div');
    block.className = `nihongo-fb-reasoning-block${collapsed ? ' nihongo-fb-reasoning-collapsed' : ''}`;

    const header = document.createElement('div');
    header.className = 'nihongo-fb-reasoning-header';
    const brain = document.createElement('i');
    brain.className = `fa-solid fa-brain${streaming ? ' fa-fade' : ''}`;
    const label = document.createElement('span');
    label.className = 'nihongo-fb-reasoning-label';
    label.textContent = streaming ? 'Thinking…' : 'Reasoning';
    const chev = document.createElement('i');
    chev.className = 'fa-solid fa-chevron-down nihongo-fb-reasoning-chev';
    header.append(brain, label, chev);
    header.addEventListener('click', () => block.classList.toggle('nihongo-fb-reasoning-collapsed'));
    block.appendChild(header);

    const text = document.createElement('div');
    text.className = 'nihongo-fb-reasoning-text';
    if (reasoning) renderFormatted(text, reasoning, { reasoning: true });
    block.appendChild(text);
    return block;
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
        renderFormatted(q, strength.quote, { inline: true });
        item.appendChild(q);
    }
    if (strength.explanation) {
        if (strength.quote) item.appendChild(document.createTextNode(' — '));
        const e = document.createElement('span');
        e.className = 'nihongo-fb-strength-exp';
        renderFormatted(e, strength.explanation, { inline: true });
        item.appendChild(e);
    }
    return item;
}

function buildRevisedBlock(text, { showApply, onApply, staging } = {}) {
    const block = document.createElement('div');
    block.className = 'nihongo-fb-section nihongo-fb-revised';

    const title = document.createElement('div');
    title.className = 'nihongo-fb-section-title';
    title.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> ';
    title.appendChild(document.createTextNode('Suggested revision'));
    block.appendChild(title);

    const textEl = document.createElement('div');
    textEl.className = 'nihongo-fb-revised-text nihongo-fb-jp';
    renderFormatted(textEl, text);
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
    // Attached-card staging: stage the whole revision (supersedes individual fixes).
    if (staging) {
        const staged = staging.isRevisedStaged();
        const stageBtn = document.createElement('button');
        stageBtn.className = `menu_button menu_button_icon nihongo-fb-stage-btn${staged ? ' nihongo-fb-staged' : ''}`;
        stageBtn.innerHTML = `<i class="fa-solid ${staged ? 'fa-square-check' : 'fa-square'}"></i> `;
        stageBtn.appendChild(document.createTextNode(staged ? 'Revision staged' : 'Stage revision'));
        stageBtn.addEventListener('click', (e) => { e.stopPropagation(); staging.toggleRevised(); });
        actions.appendChild(stageBtn);
    }
    block.appendChild(actions);
    return block;
}

// ===== Small DOM helpers =====

/**
 * Renders model text into an element through SillyTavern's `messageFormatting`
 * pipeline. This applies markdown, the registered furigana hook (so Japanese
 * gets ruby + `.nihongo-word` spans that inspect-mode tooltips recognize), and
 * DOMPurify sanitization. Always pass `isUser`/`isSystem` as false so the
 * furigana hook runs.
 *
 * For inline contexts (quotes, replacements, chips) a lone wrapping `<p>` is
 * unwrapped so the content flows inline instead of forming its own block.
 *
 * @param {HTMLElement} el
 * @param {string} text
 * @param {{inline?: boolean, reasoning?: boolean}} [opts]
 */
export function renderFormatted(el, text, opts = {}) {
    const { inline = false, reasoning = false } = opts;
    const html = messageFormatting(String(text ?? ''), '', false, false, -1, {}, reasoning);
    if (!inline) {
        el.innerHTML = html;
        return;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const kids = Array.from(tpl.content.childNodes);
    const onlyParagraph = kids.length === 1 && kids[0].nodeName === 'P';
    el.replaceChildren(...(onlyParagraph ? Array.from(kids[0].childNodes) : kids));
}

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
