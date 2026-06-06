/**
 * Writing Feedback — shared analysis engine.
 *
 * One engine, two entry points (sent-message feedback and draft review). Given
 * a target text and optional conversation context, it:
 *   1. builds the feedback prompts,
 *   2. sends a single completion request (reusing the side-chat LLM wrapper),
 *   3. buffers the final response and parses/validates it once complete,
 *   4. resolves textual anchors against the source,
 *   5. returns a normalized, render-ready outcome.
 *
 * Concurrency: every request is tied to a stable `requestKey` (chat id + source
 * text hash). An in-flight registry lets callers detect duplicates, skip
 * redundant automatic runs, and abort a specific request. A late result is the
 * caller's responsibility to validate against the current chat — the engine
 * only guarantees it won't mutate shared UI itself.
 */

import { requestCompletion } from './side-chat-llm.js';
import { buildFeedbackPrompts, collectFeedbackContext } from './feedback-prompt.js';
import {
    parseFeedbackResponse,
    resolveResultAnchors,
    hashText,
    FEEDBACK_LOG_PREFIX,
} from './feedback-schema.js';

/** Max tokens for a feedback response (structured JSON can be sizable). */
const FEEDBACK_MAX_TOKENS = 1536;

/** @type {Map<string, AbortController>} key -> controller for in-flight requests. */
const inFlight = new Map();

// ===== Public API =====

/**
 * @typedef {Object} FeedbackRunOutcome
 * @property {boolean} ok
 * @property {import('./feedback-schema.js').FeedbackResult} [result]
 * @property {string} [error]      Human-readable error (parse/validation/network/abort).
 * @property {boolean} [aborted]   True when the request was cancelled.
 * @property {string} [raw]        Raw model output (for a debug disclosure).
 * @property {FeedbackRunMeta} meta
 *
 * @typedef {Object} FeedbackRunMeta
 * @property {string} sourceHash
 * @property {string} model
 * @property {string} profileId
 * @property {number} durationMs
 */

/**
 * @typedef {Object} FeedbackRunOptions
 * @property {string} targetText           - The Japanese to review.
 * @property {number|null} [beforeIndex]   - Exclusive chat index bound for context (null = up to latest).
 * @property {string} [requestKey]         - Stable identity for dedup/abort (see buildRequestKey).
 * @property {AbortController} [controller]- Caller-owned controller; created if omitted.
 * @property {(status: string) => void} [onStatus]      - Lifecycle status callback ('analyzing').
 * @property {(reasoning: string) => void} [onReasoning]- Streamed provider reasoning (transient).
 */

/**
 * Runs a feedback analysis end-to-end.
 * @param {FeedbackRunOptions} options
 * @returns {Promise<FeedbackRunOutcome>}
 */
export async function runFeedback(options) {
    const {
        targetText,
        beforeIndex = null,
        requestKey,
        onStatus,
        onReasoning,
    } = options;

    const controller = options.controller || new AbortController();
    const signal = controller.signal;
    const sourceHash = hashText(targetText);
    const startTime = Date.now();

    /** @type {FeedbackRunMeta} */
    const meta = { sourceHash, model: '', profileId: '', durationMs: 0 };

    if (requestKey) {
        // If a request with this key is already running, abort the old one —
        // callers that want to *skip* duplicates should check isFeedbackInFlight first.
        inFlight.get(requestKey)?.abort();
        inFlight.set(requestKey, controller);
    }

    try {
        const contextMessages = collectFeedbackContext(beforeIndex);
        const { systemPrompt, userPrompt } = buildFeedbackPrompts({ targetText, contextMessages });
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        onStatus?.('analyzing');

        const response = await requestCompletion({
            messages,
            maxTokens: FEEDBACK_MAX_TOKENS,
            signal,
            fallbackSystemPrompt: systemPrompt,
            fallbackUserPrompt: userPrompt,
            // Stream provider reasoning (transient) when the caller wants it. We
            // still buffer and parse only the final content.
            onStream: onReasoning ? (update) => onReasoning(update.reasoning || '') : undefined,
        });

        meta.model = response.model || '';
        meta.profileId = response.profileId || '';
        meta.durationMs = Date.now() - startTime;

        if (signal.aborted) {
            return { ok: false, aborted: true, error: 'Cancelled.', meta };
        }

        const parsed = parseFeedbackResponse(response.content);
        if (!parsed.ok) {
            console.warn(`${FEEDBACK_LOG_PREFIX} Parse failed:`, parsed.error);
            return { ok: false, error: parsed.error, raw: parsed.raw, meta };
        }

        resolveResultAnchors(parsed.result, targetText);
        return { ok: true, result: parsed.result, raw: parsed.raw, meta };
    } catch (error) {
        meta.durationMs = Date.now() - startTime;
        if (signal.aborted || error?.name === 'AbortError') {
            return { ok: false, aborted: true, error: 'Cancelled.', meta };
        }
        console.error(`${FEEDBACK_LOG_PREFIX} Feedback request failed:`, error);
        return { ok: false, error: error?.message || 'Feedback request failed.', meta };
    } finally {
        if (requestKey && inFlight.get(requestKey) === controller) {
            inFlight.delete(requestKey);
        }
    }
}

/**
 * Builds a stable request key from the chat id and source text. Late results
 * can be validated against the active chat by recomputing this key.
 * @param {string} chatId
 * @param {string} sourceText
 * @returns {string}
 */
export function buildRequestKey(chatId, sourceText) {
    return `${chatId || '?'}::${hashText(sourceText)}`;
}

/**
 * Whether a feedback request with the given key is currently running.
 * @param {string} key
 * @returns {boolean}
 */
export function isFeedbackInFlight(key) {
    return inFlight.has(key);
}

/**
 * Aborts the in-flight feedback request with the given key, if any.
 * @param {string} key
 */
export function abortFeedback(key) {
    inFlight.get(key)?.abort();
}

/** Re-export so callers hash consistently with the engine. */
export { hashText as feedbackSourceHash };
