/**
 * LLM call wrapper for the Language Assistant side chat.
 *
 * Handles:
 * - Connection Manager profile-based requests (streaming + non-streaming)
 * - Fallback to generateRaw when no profile configured
 * - Abort support
 * - Prompt building with macro substitution
 */

import { substituteParams, generateRaw } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../../extensions/shared.js';
import { extension_settings } from '../../../../extensions.js';
import { nihongoSettings } from './settings.js';
import { getMainSystemPrompt, getActionInstructions, getUserPrompt, getPresetFieldMacros } from './side-chat-prompts.js';
import { EXTENSION_NAME } from '../index.js';

/** Default max tokens for side chat responses */
const MAX_TOKENS = 1024;

// ===== Public API =====

/**
 * @typedef {Object} BuiltPrompts
 * @property {string} mainSystemPrompt - Stable system prompt (personality + rules, cacheable)
 * @property {string} actionInstructions - Action-specific instructions (injected at depth)
 * @property {string} userPrompt - Full macro-substituted user prompt
 */

/**
 * @typedef {Object} LLMCallOptions
 * @property {string} mainSystemPrompt - Stable system prompt (from buildPrompts)
 * @property {string} actionInstructions - Action instructions at depth (from buildPrompts)
 * @property {string} userPrompt - Full user prompt (from buildPrompts)
 * @property {Array<{role: string, content: string}>} [history] - Previous messages in conversation
 * @property {(update: {text: string, reasoning: string}) => void} [onStream] - Streaming callback
 * @property {AbortSignal} [signal] - Abort signal
 */

/**
 * @typedef {Object} LLMCallResult
 * @property {string} content - Generated text
 * @property {string} reasoning - Model reasoning/thinking (if available)
 * @property {string} model - Model name used
 * @property {string} profileId - Profile ID used
 * @property {boolean} streamed - Whether response was streamed
 */

/**
 * Builds and substitutes all prompts for a chat request.
 * Returns pre-built prompt strings for storage on ChatMessage and for the LLM call.
 *
 * @param {string} actionId - Action type
 * @param {Object} context - Word/sentence context
 * @param {string} [userMessage] - Free-form user input (for custom questions)
 * @returns {BuiltPrompts}
 */
export function buildPrompts(actionId, context, userMessage) {
    const dynamicMacros = buildDynamicMacros(context || {}, userMessage);
    const macroOptions = { dynamicMacros };

    const mainSystemTemplate = getMainSystemPrompt();
    const instructionsTemplate = getActionInstructions(actionId) || getActionInstructions('explain') || '';
    const userPromptTemplate = getUserPrompt(actionId) || userMessage || '';

    return {
        mainSystemPrompt: substituteParams(mainSystemTemplate, macroOptions),
        actionInstructions: substituteParams(instructionsTemplate, macroOptions),
        userPrompt: substituteParams(userPromptTemplate, macroOptions),
    };
}

/**
 * Sends a chat request to the configured LLM.
 * Accepts pre-built prompts (from buildPrompts) and conversation history.
 *
 * @param {LLMCallOptions} options
 * @returns {Promise<LLMCallResult>}
 */
export async function sendChatRequest(options) {
    const { mainSystemPrompt, actionInstructions, userPrompt, history = [], onStream, signal } = options;

    const profileId = nihongoSettings.chatProfileId;

    // Build message array: stable system + history + system-at-depth + user
    const messages = buildMessages(mainSystemPrompt, actionInstructions, userPrompt, history);

    // Attempt LLM call
    if (profileId && isConnectionManagerAvailable()) {
        return await callWithConnectionManager(profileId, messages, onStream, signal);
    }

    // Fallback: generateRaw (no streaming, no reasoning)
    return await callWithGenerateRaw(userPrompt, mainSystemPrompt + '\n\n' + actionInstructions, signal);
}

/**
 * Checks if Connection Manager extension is available and enabled.
 * @returns {boolean}
 */
export function isConnectionManagerAvailable() {
    try {
        return !extension_settings?.disabledExtensions?.includes('connection-manager');
    } catch {
        return false;
    }
}

/**
 * Gets available connection profiles for the settings UI.
 * @returns {Array<{id: string, name: string}>}
 */
export function getAvailableProfiles() {
    if (!isConnectionManagerAvailable()) return [];
    try {
        const context = SillyTavern.getContext();
        const profiles = context.extensionSettings?.connectionManager?.profiles || [];
        return profiles.map(p => ({ id: p.id, name: p.name }));
    } catch {
        return [];
    }
}

/**
 * Gets the profile icon for display.
 * @param {string} [profileId]
 * @returns {HTMLImageElement|null}
 */
export function getProfileIcon(profileId) {
    const id = profileId || nihongoSettings.chatProfileId;
    if (!id || !isConnectionManagerAvailable()) return null;
    try {
        return ConnectionManagerRequestService.getProfileIcon(id);
    } catch {
        return null;
    }
}

// ===== Internal =====

/**
 * Builds dynamic macros object for prompt substitution.
 * Each macro is a full MacroDefinitionOptions object with a handler function,
 * making them future-proof for inline autocomplete and self-documenting.
 *
 * @param {Object} context
 * @param {string} [userMessage]
 * @returns {Record<string, import('../../../../macros/engine/MacroEnv.types.js').DynamicMacroValue>}
 */
function buildDynamicMacros(context, userMessage) {
    // Merge preset field macros (personality, description, rules) with runtime context macros
    const presetMacros = getPresetFieldMacros();
    return {
        ...presetMacros,
        nihongoWord: {
            description: 'The Japanese text being asked about (surface form as it appears in the message)',
            handler: () => context.word || '',
        },
        nihongoDictWord: {
            description: 'The dictionary/base form of the word (if different from surface text, e.g. 書く for 書きます)',
            handler: () => context.dictWord || '',
        },
        nihongoReading: {
            description: 'Kana reading of the word (with parentheses if present)',
            handler: () => context.reading ? ` (${context.reading})` : '',
        },
        nihongoSentence: {
            description: 'The context sentence containing the word',
            handler: () => context.sentence || '(no context available)',
        },
        nihongoParagraph: {
            description: 'Broader paragraph context around the word',
            handler: () => context.paragraph || context.sentence || '',
        },
        nihongoPos: {
            description: 'Part of speech of the word (from tokenizer or dictionary)',
            handler: () => context.pos || 'unknown',
        },
        nihongoAction: {
            description: 'The action type (explain, translate, alternatives, grammar)',
            handler: () => context.action || 'explain',
        },
        nihongoUserMessage: {
            description: 'Free-form user input for custom questions',
            handler: () => userMessage || '',
        },
        nihongoKnownKanjiCount: {
            description: 'Number of kanji the student has marked as known',
            handler: () => String(nihongoSettings.knownKanjiCount || 0),
        },
        nihongoKnownKanji: {
            description: 'Comma-separated list of known kanji characters',
            handler: () => nihongoSettings.knownKanji || '',
        },
    };
}

/**
 * Builds the messages array for the LLM call.
 * Layout: [stable system] + [history pairs/triples] + [system-at-depth] + [user]
 *
 * @param {string} mainSystemPrompt - Stable system prompt (personality + rules)
 * @param {string} actionInstructions - Action-specific instructions (at depth)
 * @param {string} userPrompt - Current user message
 * @param {Array<{role: string, content: string}>} history - Previous turns (may include system messages per history mode)
 * @returns {Array<{role: string, content: string}>}
 */
function buildMessages(mainSystemPrompt, actionInstructions, userPrompt, history) {
    const messages = [];

    // Stable system prompt at position 0 (cacheable prefix)
    if (mainSystemPrompt) {
        messages.push({ role: 'system', content: mainSystemPrompt });
    }

    // Conversation history (user/assistant pairs, optionally with system messages)
    for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
    }

    // Action instructions at depth (just before current user message)
    if (actionInstructions) {
        messages.push({ role: 'system', content: actionInstructions });
    }

    // Current user message
    if (userPrompt) {
        messages.push({ role: 'user', content: userPrompt });
    }

    return messages;
}

/**
 * Calls LLM via Connection Manager (streaming with fallback).
 * @param {string} profileId
 * @param {Array<{role: string, content: string}>} messages
 * @param {Function} [onStream]
 * @param {AbortSignal} [signal]
 * @returns {Promise<LLMCallResult>}
 */
async function callWithConnectionManager(profileId, messages, onStream, signal) {
    let model = '';
    try {
        const profile = ConnectionManagerRequestService.getProfile(profileId);
        model = profile?.model || '';
    } catch { /* ignore */ }

    // Try streaming first
    if (onStream) {
        try {
            const streamResponse = await ConnectionManagerRequestService.sendRequest(
                profileId,
                messages,
                MAX_TOKENS,
                { extractData: true, includePreset: true, stream: true, signal },
            );

            if (typeof streamResponse === 'function') {
                const generator = streamResponse();
                let finalText = '';
                let finalReasoning = '';
                for await (const chunk of generator) {
                    finalText = chunk.text;
                    finalReasoning = chunk.state?.reasoning || '';
                    onStream({ text: finalText, reasoning: finalReasoning });
                }
                return { content: finalText, reasoning: finalReasoning, model, profileId, streamed: true };
            }

            // Not a stream generator — extract as non-streaming
            const extracted = extractResponse(streamResponse);
            return { ...extracted, model, profileId, streamed: false };
        } catch (error) {
            if (signal?.aborted) throw error;
            console.warn(`[${EXTENSION_NAME}] Streaming failed, falling back to non-streaming:`, error);
        }
    }

    // Non-streaming fallback
    const response = await ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        MAX_TOKENS,
        { extractData: true, includePreset: true, stream: false, signal },
    );

    const extracted = extractResponse(response);
    return { ...extracted, model, profileId, streamed: false };
}

/**
 * Fallback: uses ST's generateRaw (no Connection Manager).
 * @param {string} prompt
 * @param {string} systemPrompt
 * @param {AbortSignal} [signal]
 * @returns {Promise<LLMCallResult>}
 */
async function callWithGenerateRaw(prompt, systemPrompt, signal) {
    signal?.throwIfAborted();
    const result = await generateRaw({ prompt, systemPrompt, instructOverride: true });
    signal?.throwIfAborted();
    return { content: result || '', reasoning: '', model: 'main', profileId: '', streamed: false };
}

/**
 * Extracts content/reasoning from a non-streaming response.
 * @param {*} response
 * @returns {{content: string, reasoning: string}}
 */
function extractResponse(response) {
    if (typeof response === 'string') return { content: response, reasoning: '' };
    return { content: response?.content || '', reasoning: response?.reasoning || '' };
}
