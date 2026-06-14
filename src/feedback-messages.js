/**
 * Writing Feedback — sent-message entry point.
 *
 * Adds a per-message action button that analyzes a user-authored message and
 * attaches a compact feedback card directly beneath it. Feedback is persisted
 * as extension-owned metadata on the message (`message.extra.nihongoFeedback`),
 * so it:
 *   - survives re-render / reopening (it travels with the message object),
 *   - never becomes part of the main character prompt (custom extra key only),
 *   - disappears when the message is deleted,
 *   - is marked stale when the message is edited.
 *
 * Concurrency & chat-switch safety: every run is tied to a stable request key
 * (chat id + source-text hash) via the engine's in-flight registry, and late
 * results are validated against both the current chat and the message object's
 * continued presence before they attach or persist.
 */

import { eventSource, updateMessageBlock, saveChatConditional } from '../../../../../script.js';
import { event_types } from '../../../../events.js';
import { EXTENSION_NAME } from '../index.js';
import { nihongoSettings } from './settings.js';
import { getActivePresetId, getActivePreset } from './side-chat-prompts.js';
import { hasJapaneseContent } from './feedback-schema.js';
import { runFeedback, buildRequestKey, isFeedbackInFlight, feedbackSourceHash } from './feedback-engine.js';
import { createFeedbackCard } from './feedback-render.js';
import { createFeedbackSession, applyOverlayState, clearInlineMarks, closeFeedbackPopover } from './feedback-overlay.js';

/** Persisted record schema version. */
const RECORD_VERSION = 1;

/** Extra-metadata key. Custom key → never touches the main prompt. */
const EXTRA_KEY = 'nihongoFeedback';

/** Message-action button class. */
const BUTTON_CLASS = 'mes_nihongo_feedback';

/**
 * Live (in-flight) cards keyed by request key, so streaming updates and the
 * final result target the right card even if other messages re-render.
 * @type {Map<string, import('./feedback-render.js').FeedbackCard>}
 */
const liveCards = new Map();

// ===== Public API =====

/** Initializes the sent-message feedback feature. Call once during init. */
export function initFeedbackMessages() {
    injectFeedbackButton();

    // Delegated click handler for the per-message feedback button.
    document.addEventListener('click', onFeedbackButtonClick);

    // Re-attach / refresh cards across the lifecycle.
    eventSource.on(event_types.CHAT_CHANGED, () => refreshAllFeedbackCards());
    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => refreshAllFeedbackCards());
    eventSource.on(event_types.MESSAGE_UPDATED, (id) => refreshMessageFeedback(id));
    eventSource.on(event_types.MESSAGE_EDITED, (id) => refreshMessageFeedback(id));
    eventSource.on(event_types.MESSAGE_SWIPED, (id) => refreshMessageFeedback(id));
    eventSource.on(event_types.MESSAGE_DELETED, () => refreshAllFeedbackCards());

    // Auto feedback on freshly-sent user messages (mode-gated; see runAutoFeedback).
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => {
        ensureButtonOnMessage(getMessageElement(id));
        runAutoFeedback(id);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => ensureButtonOnMessage(getMessageElement(id)));

    // Re-evaluate inline-overlay visibility on all cards when the mode changes.
    document.addEventListener('nihongo-feedback-inline-mode-changed', () => refreshAllFeedbackCards());
}

/**
 * Runs (or re-runs) feedback for a message and attaches the result card.
 *
 * @param {number} messageId - Chat index of the message.
 * @param {Object} [opts]
 * @param {boolean} [opts.regenerate=false] - Force a fresh run even if feedback exists.
 * @param {boolean} [opts.auto=false]        - Triggered by automatic mode.
 * @returns {Promise<void>}
 */
export async function runFeedbackForMessage(messageId, opts = {}) {
    const ctx = safeContext();
    if (!ctx) return;
    const index = Number(messageId);
    const message = ctx.chat?.[index];
    if (!message) return;

    const targetText = typeof message.mes === 'string' ? message.mes.trim() : '';
    if (!targetText) {
        if (!opts.auto) toast('Nothing to review in this message.', 'info');
        return;
    }

    const chatId = ctx.getCurrentChatId();
    const sourceHash = feedbackSourceHash(targetText);
    const requestKey = buildRequestKey(chatId, targetText);

    const existing = getRecord(message);

    // A manual click on fresh feedback just reveals it (regenerate via the card).
    if (!opts.regenerate && existing && existing.sourceHash === sourceHash) {
        const mesEl = getMessageElement(index);
        if (mesEl) {
            renderPersistedCard(mesEl, message, { expand: !opts.auto });
        }
        return;
    }

    // Avoid duplicate concurrent work for the same source text. A manual click
    // while a run is in flight just reveals the existing loading card.
    if (isFeedbackInFlight(requestKey) && !opts.regenerate) {
        if (!opts.auto) liveCards.get(requestKey)?.setExpanded(true);
        return;
    }

    const mesEl = getMessageElement(index);
    if (!mesEl) return;

    // Place a loading card immediately.
    const controller = new AbortController();
    const card = createFeedbackCard({
        mode: 'attached',
        expanded: nihongoSettings.feedbackExpandedByDefault || !opts.auto,
        callbacks: {
            onRegenerate: () => runFeedbackForMessage(findIndex(message), { regenerate: true }),
            onRemove: () => removeFeedback(message),
            onRetry: () => runFeedbackForMessage(findIndex(message), { regenerate: true }),
        },
    });
    card.setLoading();
    placeCard(mesEl, card.element);
    liveCards.set(requestKey, card);

    try {
        const outcome = await runFeedback({
            targetText,
            beforeIndex: index,
            requestKey,
            controller,
            onReasoning: (reasoning) => { if (reasoning) card.setLoading(reasoning); },
        });

        // ── Chat-switch / deletion safety: validate before touching anything. ──
        const liveCtx = safeContext();
        if (!liveCtx || liveCtx.getCurrentChatId() !== chatId) {
            return; // user switched chats — discard silently
        }
        const liveIndex = liveCtx.chat?.indexOf(message);
        if (liveIndex === -1 || liveIndex == null) {
            return; // message was deleted — discard
        }
        const liveEl = getMessageElement(liveIndex);

        if (outcome.aborted) {
            // A newer run replaced this one (regenerate); leave the newer card.
            return;
        }

        if (!outcome.ok) {
            card.setError(outcome.error || 'Feedback failed.', outcome.raw);
            return;
        }

        // Persist, then update the existing live card in place. (We can't call
        // renderPersistedCard here — its live-card guard would no-op while this
        // request is still registered; the card already has the right callbacks.)
        setRecord(message, buildRecord(outcome.result, sourceHash, outcome.reasoning));
        await liveCtx.saveChat();
        const session = makeSession(message, outcome.result, false);
        if (liveEl) placeCard(liveEl, card.element);
        card.setResult(outcome.result, { stale: false, reasoning: outcome.reasoning, session });
        updateOverlay(message, session, false);
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Feedback run error:`, err);
        card.setError(err?.message || 'Feedback failed.');
    } finally {
        if (liveCards.get(requestKey) === card) liveCards.delete(requestKey);
    }
}

// ===== Automatic mode =====

/**
 * Runs automatic feedback for a just-sent user message when enabled and
 * eligible. Detached (never awaited) so it can't delay main generation.
 * @param {number} messageId
 */
function runAutoFeedback(messageId) {
    const mode = nihongoSettings.feedbackAutoMode;
    if (mode === 'off') return;

    const ctx = safeContext();
    const message = ctx?.chat?.[Number(messageId)];
    if (!message || !message.is_user || message.is_system) return;

    const text = typeof message.mes === 'string' ? message.mes.trim() : '';
    if (!text) return;

    // Cheap local check: skip clearly non-Japanese content.
    if (mode === 'japanese' && !hasJapaneseContent(text, 2)) return;

    // Skip if fresh feedback already exists for this exact text.
    const existing = getRecord(message);
    if (existing && existing.sourceHash === feedbackSourceHash(text)) return;

    // Fire and forget — errors surface on the card, not to the main chat.
    void runFeedbackForMessage(Number(messageId), { auto: true });
}

// ===== Persistence helpers =====

/** @param {object} message @returns {object|null} */
function getRecord(message) {
    const rec = message?.extra?.[EXTRA_KEY];
    return (rec && typeof rec === 'object' && rec.result) ? rec : null;
}

/** @param {object} message @param {object} record */
function setRecord(message, record) {
    if (typeof message.extra !== 'object' || message.extra === null) message.extra = {};
    message.extra[EXTRA_KEY] = record;
}

/**
 * @param {import('./feedback-schema.js').FeedbackResult} result
 * @param {string} sourceHash
 * @param {string} [reasoning] - Model reasoning/thinking captured during the run.
 * @returns {object}
 */
function buildRecord(result, sourceHash, reasoning = '') {
    const preset = getActivePreset();
    return {
        v: RECORD_VERSION,
        sourceHash,
        createdAt: new Date().toISOString(),
        presetId: getActivePresetId() || '',
        presetName: preset?.name || '',
        sensitivity: nihongoSettings.feedbackSensitivity,
        reasoning: typeof reasoning === 'string' ? reasoning : '',
        result,
    };
}

/**
 * Removes feedback from a message (metadata + DOM card) and persists.
 * @param {object} message
 */
async function removeFeedback(message) {
    if (message?.extra && EXTRA_KEY in message.extra) {
        delete message.extra[EXTRA_KEY];
    }
    const ctx = safeContext();
    const index = ctx?.chat?.indexOf(message);
    if (index != null && index >= 0) {
        const mesEl = getMessageElement(index);
        mesEl?.querySelector(':scope .mes_block > .nihongo-feedback-card')?.remove();
        clearInlineMarks(mesEl);
    }
    closeFeedbackPopover();
    try { await ctx?.saveChat(); } catch { /* ignore */ }
}

// ===== Rendering / attachment =====

/**
 * Renders the persisted feedback card for a message (computing staleness),
 * unless an in-flight live card is already present.
 * @param {HTMLElement} mesEl
 * @param {object} message
 * @param {{expand?: boolean}} [opts]
 */
function renderPersistedCard(mesEl, message, opts = {}) {
    const record = getRecord(message);
    if (!record) return;

    const text = typeof message.mes === 'string' ? message.mes : '';
    const requestKey = buildRequestKey(safeContext()?.getCurrentChatId(), text.trim());
    if (liveCards.has(requestKey)) return; // a loading card owns this slot

    const stale = feedbackSourceHash(text) !== record.sourceHash;
    const card = createFeedbackCard({
        mode: 'attached',
        expanded: opts.expand ?? nihongoSettings.feedbackExpandedByDefault,
        callbacks: {
            onRegenerate: () => runFeedbackForMessage(findIndex(message), { regenerate: true }),
            onRemove: () => removeFeedback(message),
        },
    });
    const session = makeSession(message, record.result, stale);
    card.setResult(record.result, { stale, reasoning: record.reasoning, session });
    placeCard(mesEl, card.element);
    updateOverlay(message, session, stale);
}

// ===== Inline overlay + staging =====

/**
 * Creates a per-message feedback session wiring staging + inline highlights to
 * the current settings, and subscribes the overlay to it.
 * @param {object} message
 * @param {import('./feedback-schema.js').FeedbackResult} result
 * @param {boolean} stale
 * @returns {import('./feedback-overlay.js').FeedbackSession}
 */
function makeSession(message, result, stale) {
    const mode = nihongoSettings.feedbackInlineMode;
    const index = findIndex(message);
    const session = createFeedbackSession({
        result,
        getSourceText: () => (typeof message.mes === 'string' ? message.mes : ''),
        applyAllowed: !stale && isApplyAllowed(index),
        inlineToggleable: mode !== 'always',
        initialInlineVisible: computeInitialInline(index, mode),
        onCommit: (text) => applyTextToMessage(message, text),
    });
    // Drive the inline marks from staging/visibility changes (staleness is fixed
    // for this card's lifetime — an edit rebuilds the card with a new session).
    session.subscribe(() => updateOverlay(message, session, stale));
    return session;
}

/** Brings a message's inline marks in line with its session + staleness. */
function updateOverlay(message, session, stale) {
    const idx = findIndex(message);
    const el = idx >= 0 ? getMessageElement(idx) : null;
    applyOverlayState(el, session, { stale });
}

/** Whether `auto` mode should auto-show marks here: the latest user message. */
function computeInitialInline(index, mode) {
    if (mode === 'always') return true;
    if (mode === 'auto') return isLatestUserMessage(index);
    return false; // off — revealed only via the per-message toggle
}

/** True when no newer user message follows `index` (positional 'latest'). */
function isLatestUserMessage(index) {
    const chat = safeContext()?.chat;
    if (!chat || index < 0) return false;
    for (let i = index + 1; i < chat.length; i++) {
        if (chat[i]?.is_user) return false;
    }
    return true;
}

/** Whether in-place apply is offered for `index`, per the apply policy. */
function isApplyAllowed(index) {
    const chat = safeContext()?.chat;
    if (!chat || index < 0) return false;
    const policy = nihongoSettings.feedbackApplyPolicy;
    if (policy === 'always') return true;
    const after = chat.length - 1 - index;
    if (policy === 'latest-only') return after <= 0;
    return after <= 1; // one-reply (default): tolerate a single reply after
}

/**
 * Commits staged text to the message in one edit, then persists + re-renders.
 * The feedback then goes stale (text changed) and a regenerate is offered.
 * @param {object} message
 * @param {string} newText
 */
async function applyTextToMessage(message, newText) {
    const ctx = safeContext();
    const index = ctx?.chat?.indexOf(message);
    if (index == null || index < 0) return;

    closeFeedbackPopover();
    message.mes = newText;
    if (message.swipe_id !== undefined && Array.isArray(message.swipes)) {
        message.swipes[message.swipe_id] = newText;
    }
    // Re-render the message body (re-applies furigana), persist, and notify.
    updateMessageBlock(index, message);
    await saveChatConditional();
    await eventSource.emit(event_types.MESSAGE_UPDATED, index);
}

/**
 * Re-attaches / refreshes the feedback card for a single message id.
 * @param {number|string} messageId
 */
function refreshMessageFeedback(messageId) {
    const ctx = safeContext();
    const index = Number(messageId);
    const message = ctx?.chat?.[index];
    const mesEl = getMessageElement(index);
    if (!message || !mesEl) return;
    ensureButtonOnMessage(mesEl);

    if (getRecord(message)) {
        renderPersistedCard(mesEl, message);
    } else {
        // No record — drop any stale card DOM.
        mesEl.querySelector(':scope .mes_block > .nihongo-feedback-card')?.remove();
    }
}

/** Scans all rendered messages and (re)attaches buttons + persisted cards. */
function refreshAllFeedbackCards() {
    const ctx = safeContext();
    if (!ctx) return;
    const messages = document.querySelectorAll('#chat .mes');
    for (const mesEl of messages) {
        ensureButtonOnMessage(mesEl);
        const index = Number(mesEl.getAttribute('mesid'));
        if (Number.isNaN(index)) continue;
        const message = ctx.chat?.[index];
        if (message && getRecord(message)) {
            renderPersistedCard(mesEl, message);
        }
    }
}

/**
 * Places a card element beneath the message text (end of `.mes_block`),
 * replacing any prior card.
 * @param {HTMLElement} mesEl
 * @param {HTMLElement} cardEl
 */
function placeCard(mesEl, cardEl) {
    const block = mesEl?.querySelector('.mes_block');
    if (!block) return;
    block.querySelector(':scope > .nihongo-feedback-card')?.remove();
    block.appendChild(cardEl);
}

// ===== Button injection =====

/** Injects the action button into the message template and existing messages. */
function injectFeedbackButton() {
    const tmpl = document.querySelector('#message_template .extraMesButtons');
    if (tmpl && !tmpl.querySelector(`.${BUTTON_CLASS}`)) {
        tmpl.appendChild(makeButton());
    }
    document.querySelectorAll('#chat .mes').forEach(ensureButtonOnMessage);
}

/**
 * Ensures a message element has the feedback button in its action row.
 * @param {Element|null} mesEl
 */
function ensureButtonOnMessage(mesEl) {
    if (!mesEl) return;
    const container = mesEl.querySelector('.extraMesButtons');
    if (container && !container.querySelector(`.${BUTTON_CLASS}`)) {
        container.appendChild(makeButton());
    }
}

/** @returns {HTMLDivElement} */
function makeButton() {
    const btn = document.createElement('div');
    btn.className = `mes_button ${BUTTON_CLASS} fa-solid fa-clipboard-check interactable`;
    btn.title = 'Japanese writing feedback';
    btn.tabIndex = 0;
    return btn;
}

/** Delegated handler for clicks on the feedback button. */
function onFeedbackButtonClick(e) {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest(`.${BUTTON_CLASS}`);
    if (!btn) return;
    const mesEl = btn.closest('.mes');
    if (!mesEl) return;
    const index = Number(mesEl.getAttribute('mesid'));
    if (Number.isNaN(index)) return;
    e.preventDefault();
    e.stopPropagation();
    void runFeedbackForMessage(index);
}

// ===== Small helpers =====

/** @param {number|string} index @returns {HTMLElement|null} */
function getMessageElement(index) {
    return document.querySelector(`#chat .mes[mesid="${index}"]`);
}

/** @param {object} message @returns {number} */
function findIndex(message) {
    return safeContext()?.chat?.indexOf(message) ?? -1;
}

function safeContext() {
    try {
        return SillyTavern.getContext();
    } catch {
        return null;
    }
}

function toast(message, level = 'info') {
    if (typeof toastr !== 'undefined' && toastr[level]) toastr[level](message);
}
