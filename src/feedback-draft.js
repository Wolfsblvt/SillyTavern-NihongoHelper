/**
 * Writing Feedback — draft review entry point.
 *
 * Adds a "Review Japanese" control near the composer. It reads the current
 * draft, opens a blocking modal, runs the same feedback engine, and renders the
 * shared feedback view plus an editable working copy of the text. The original
 * composer is never touched until the user explicitly applies the working text;
 * closing/cancelling leaves it untouched.
 *
 * The message is never sent automatically — apply only writes to the composer.
 */

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { EXTENSION_NAME } from '../index.js';
import { runFeedback, buildRequestKey } from './feedback-engine.js';
import { createFeedbackCard } from './feedback-render.js';
import { attachKanjiTooltip, detachKanjiTooltip } from './kanji-tooltip.js';

const COMPOSER_BUTTON_ID = 'nihongo_review_button';
const COMPOSER_TEXTAREA_ID = 'send_textarea';

let modalOpen = false;

// ===== Public API =====

/** Initializes the draft-review feature. Call once during init. */
export function initDraftReview() {
    injectComposerButton();
}

// ===== Composer button =====

/** Adds the "Review Japanese" button to the left send-form, near the composer. */
function injectComposerButton() {
    const leftForm = document.getElementById('leftSendForm');
    if (!leftForm || document.getElementById(COMPOSER_BUTTON_ID)) return;

    const btn = document.createElement('div');
    btn.id = COMPOSER_BUTTON_ID;
    btn.className = 'fa-solid fa-clipboard-check interactable';
    btn.title = 'Review the Japanese in your message before sending';
    btn.tabIndex = 0;
    btn.addEventListener('click', openDraftReview);
    leftForm.appendChild(btn);
}

// ===== Draft review modal =====

/** Opens the draft-review modal for the current composer text. */
async function openDraftReview() {
    if (modalOpen) return;

    const textarea = getComposer();
    const draft = textarea?.value?.trim() || '';
    if (!draft) {
        toast('Type some Japanese in the message box first.', 'warning');
        return;
    }

    modalOpen = true;
    const controller = new AbortController();
    const ctx = safeContext();
    const chatId = ctx?.getCurrentChatId?.() || '';
    const requestKey = buildRequestKey(chatId, draft) + '::draft';

    // The editable working copy is created first so the card callbacks can
    // close over it (apply-revised / apply-fix write into it, never the composer).
    const workingInput = document.createElement('textarea');
    workingInput.className = 'text_pole';
    workingInput.rows = 3;
    workingInput.value = draft;

    const card = createFeedbackCard({
        mode: 'modal',
        showApply: true,
        callbacks: {
            onApplyRevised: (text) => { workingInput.value = text; },
            onApplyIssue: (issue) => {
                // Re-resolve against the *current* working text so earlier edits
                // or an applied revision can't cause a wrong replacement.
                const applied = applyIssueToText(workingInput.value, issue);
                if (applied == null) {
                    toast('Can\'t safely apply this fix — the text changed or the phrase is ambiguous.', 'warning');
                    return;
                }
                workingInput.value = applied;
            },
            onRetry: () => { void runAnalysis(); },
        },
    });
    card.setLoading();

    const root = buildModalBody(card.element, workingInput, draft);

    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: 'Apply to composer',
        cancelButton: 'Close',
        wide: true,
        allowVerticalScrolling: true,
        // Abort the in-flight request whenever the modal closes (OK or cancel).
        onClosing: () => { controller.abort(); return true; },
    });

    // Give the modal the same kanji/word hover tooltips as the chat. The
    // tooltip element is parented to the dialog so it layers above the popup.
    if (popup.dlg) {
        attachKanjiTooltip(popup.dlg, { boundingEl: popup.dlg, appendTo: popup.dlg });
    }

    // ── Kick off analysis (re-runnable via the card's retry). ──
    async function runAnalysis() {
        card.setLoading();
        try {
            const outcome = await runFeedback({
                targetText: draft,
                beforeIndex: null, // draft → latest visible main-chat messages
                requestKey,
                controller,
                onReasoning: (reasoning) => { if (reasoning) card.setLoading(reasoning); },
            });
            if (controller.signal.aborted || outcome.aborted) return;
            if (!outcome.ok) {
                card.setError(outcome.error || 'Feedback failed.', outcome.raw);
                return;
            }
            card.setResult(outcome.result, { reasoning: outcome.reasoning });
        } catch (err) {
            if (controller.signal.aborted) return;
            console.error(`[${EXTENSION_NAME}] Draft review failed:`, err);
            card.setError(err?.message || 'Feedback failed.');
        }
    }

    void runAnalysis();

    // ── Show and resolve ──
    let result;
    try {
        result = await popup.show();
    } finally {
        modalOpen = false;
        controller.abort();
        if (popup.dlg) detachKanjiTooltip(popup.dlg);
    }

    // Apply the working text to the composer only on explicit confirmation.
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        applyToComposer(workingInput.value);
    }
}

/**
 * Builds the modal body: the feedback card on top, an editable working copy of
 * the draft beneath it (with a reset-to-original button).
 * @param {HTMLElement} cardEl
 * @param {HTMLTextAreaElement} workingInput - Pre-created working textarea.
 * @param {string} draft - Original draft (for reset).
 * @returns {HTMLElement} The modal root element.
 */
function buildModalBody(cardEl, workingInput, draft) {
    const root = document.createElement('div');
    root.className = 'nihongo-fb-modal';
    root.appendChild(cardEl);

    const working = document.createElement('div');
    working.className = 'nihongo-fb-working';

    const label = document.createElement('label');
    label.textContent = 'Working text (this is what "Apply to composer" will use):';

    const actions = document.createElement('div');
    actions.className = 'nihongo-fb-working-actions';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'menu_button menu_button_icon';
    resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> ';
    resetBtn.appendChild(document.createTextNode('Reset to original'));
    resetBtn.addEventListener('click', () => { workingInput.value = draft; });
    actions.appendChild(resetBtn);

    working.append(label, workingInput, actions);
    root.appendChild(working);

    return root;
}

/**
 * Applies an issue's replacement to `text` by re-resolving the quote against
 * the current text. Returns the new text, or null when it cannot be applied
 * safely (quote missing, ambiguous and not disambiguated).
 * @param {string} text
 * @param {import('./feedback-schema.js').FeedbackIssue} issue
 * @returns {string|null}
 */
function applyIssueToText(text, issue) {
    if (!issue || typeof issue.replacement !== 'string' || !issue.replacement || !issue.quote) return null;

    // Count occurrences in the current working text.
    const positions = [];
    let scan = 0;
    while (true) {
        const idx = text.indexOf(issue.quote, scan);
        if (idx === -1) break;
        positions.push(idx);
        scan = idx + issue.quote.length;
    }
    if (positions.length === 0) return null;

    let targetIdx;
    if (positions.length === 1) {
        targetIdx = 0;
    } else if (issue.occurrenceProvided) {
        targetIdx = Math.max(1, issue.occurrence) - 1;
        if (targetIdx >= positions.length) return null;
    } else {
        return null; // ambiguous and not disambiguated
    }

    const start = positions[targetIdx];
    return text.slice(0, start) + issue.replacement + text.slice(start + issue.quote.length);
}

// ===== Composer helpers =====

/** @returns {HTMLTextAreaElement|null} */
function getComposer() {
    const el = document.getElementById(COMPOSER_TEXTAREA_ID);
    return el instanceof HTMLTextAreaElement ? el : null;
}

/**
 * Writes text to the composer and notifies ST via an input event.
 * @param {string} text
 */
function applyToComposer(text) {
    const ta = getComposer();
    if (!ta) return;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
}

// ===== Small helpers =====

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
