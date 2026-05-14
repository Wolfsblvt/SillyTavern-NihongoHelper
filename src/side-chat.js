/**
 * Language Assistant Side Chat — UI and session management.
 *
 * Provides a mini-chat interface in the side panel for asking language questions.
 * Supports streaming responses, reasoning display, conversation history,
 * and quick actions triggered from word tooltips.
 *
 * Architecture:
 * - ChatSession holds all messages with metadata (timestamps, context, model info)
 * - Messages use a persistent-ready format even before persistence is implemented
 * - UI renders as a scrollable message list + input bar
 * - Reasoning blocks are collapsible (collapsed once content starts streaming)
 */

import { registerTab, openSidePanel } from './side-panel.js';
import { sendChatRequest, buildPrompts, getProfileIcon } from './side-chat-llm.js';
import { getChatAction } from './side-chat-prompts.js';
import { nihongoSettings } from './settings.js';
import { EXTENSION_NAME } from '../index.js';
import { humanizeGenTime } from '../../../../RossAscends-mods.js';
import { messageFormatting } from '../../../../../script.js';

// ===== Data Model =====

/**
 * @typedef {Object} ChatMessage
 * @property {string} id - Unique message ID
 * @property {'user'|'assistant'|'system'|'action'} role - Message role
 * @property {string} content - Short display text (shown in UI bubble)
 * @property {string} [prompt] - Full macro-substituted user prompt sent to LLM (for history + expandable peek)
 * @property {string} [instructions] - Action system-at-depth that was active for this turn (for UI peek + optional history)
 * @property {string} [actionId] - Which action produced this turn (for dedup logic in history mode)
 * @property {string} reasoning - Model reasoning/thinking (assistant only)
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {ChatContext|null} context - Word/action context that triggered this message
 * @property {ChatMeta|null} meta - Generation metadata (assistant only)
 */

/**
 * @typedef {Object} ChatContext
 * @property {string} word - The surface text being discussed (what the user hovered/selected)
 * @property {string} dictWord - Dictionary/base form (if different from surface text)
 * @property {string} reading - Kana reading
 * @property {string} sentence - Context sentence from chat
 * @property {string} paragraph - Broader paragraph context
 * @property {string} pos - Part of speech
 * @property {string} action - Action type (explain, translate, alternatives, grammar, custom)
 * @property {string|null} messageId - Which ST chat message it was invoked from
 * @property {string|null} matchId - Token matcher span ID (for tooltip-originated queries)
 */

/**
 * @typedef {Object} ChatMeta
 * @property {string} profileId - Connection profile used
 * @property {string} model - Model name
 * @property {number|null} durationMs - Generation time in ms
 * @property {boolean} streamed - Whether response was streamed
 */

/**
 * @typedef {Object} ChatSession
 * @property {string} id - Session ID
 * @property {string} createdAt - ISO 8601
 * @property {string} lastActiveAt - ISO 8601
 * @property {ChatMessage[]} messages - All messages
 * @property {Object} sessionContext - Session-level context
 * @property {string} sessionContext.characterName - Active character
 * @property {string} sessionContext.userName - Active user name
 */

// ===== State =====

/** @type {ChatSession|null} */
let currentSession = null;

/** @type {HTMLElement|null} */
let messageList = null;
/** @type {HTMLTextAreaElement|null} */
let inputEl = null;
/** @type {HTMLButtonElement|null} */
let sendBtn = null;
/** @type {AbortController|null} */
let activeRequest = null;
/** @type {HTMLElement|null} */
let streamingMessageEl = null;

// ===== Public API =====

/**
 * Initializes the side chat tab. Call during extension init.
 */
export function initSideChat() {
    registerTab('chat', {
        icon: 'fa-comments',
        label: 'Chat',
        build: buildChatView,
        onActivate: () => {
            if (inputEl) requestAnimationFrame(() => inputEl.focus());
        },
    });
}

/**
 * Opens the side chat and triggers a quick action.
 * Called from tooltip buttons.
 *
 * @param {string} actionId - Action type (explain, translate, alternatives, grammar)
 * @param {Object} context - Word context
 * @param {string} context.word
 * @param {string} [context.dictWord]
 * @param {string} [context.reading]
 * @param {string} [context.sentence]
 * @param {string} [context.paragraph]
 * @param {string} [context.pos]
 * @param {string} [context.messageId]
 * @param {string} [context.matchId]
 */
export function triggerChatAction(actionId, context) {
    openSidePanel('chat');

    // Start a new session or continue existing
    ensureSession();

    const action = getChatAction(actionId);
    if (!action) return;

    // Add the user "action" message
    const userMsg = createMessage('user', formatActionMessage(action, context), {
        context: { ...context, action: actionId },
    });
    addMessage(userMsg);

    // Send to LLM
    generateResponse(actionId, context);
}

// ===== Internal: View Builder =====

/** @type {import('./side-chat-llm.js').BuiltPrompts|null} */
let lastBuiltPrompts = null;

/** Builds the chat tab's DOM. Called once (lazy). */
function buildChatView() {
    const view = document.createElement('div');
    view.className = 'nihongo-chat-view';

    // Header bar
    const headerBar = document.createElement('div');
    headerBar.className = 'nihongo-chat-header';

    const viewPromptBtn = document.createElement('button');
    viewPromptBtn.className = 'nihongo-chat-header-btn';
    viewPromptBtn.title = 'View full prompt as sent to LLM';
    viewPromptBtn.innerHTML = '<i class="fa-solid fa-terminal"></i>';
    viewPromptBtn.addEventListener('click', showPromptViewer);

    const newChatBtn = document.createElement('button');
    newChatBtn.className = 'nihongo-chat-header-btn';
    newChatBtn.title = 'Start new conversation';
    newChatBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
    newChatBtn.addEventListener('click', () => {
        currentSession = null;
        lastBuiltPrompts = null;
        ensureSession();
        if (messageList) {
            messageList.innerHTML = '';
            showEmptyState();
        }
    });

    headerBar.appendChild(viewPromptBtn);
    headerBar.appendChild(newChatBtn);

    // Message list
    messageList = document.createElement('div');
    messageList.className = 'nihongo-chat-messages';

    // Empty state
    showEmptyState();

    // Input area
    const inputBar = document.createElement('div');
    inputBar.className = 'nihongo-chat-input-bar';

    inputEl = document.createElement('textarea');
    inputEl.className = 'nihongo-chat-input';
    inputEl.placeholder = 'Ask about a word or grammar...';
    inputEl.rows = 1;
    inputEl.addEventListener('input', autoResizeInput);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    sendBtn = document.createElement('button');
    sendBtn.className = 'nihongo-chat-send';
    sendBtn.title = 'Send';
    sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    sendBtn.addEventListener('click', handleSend);

    inputBar.appendChild(inputEl);
    inputBar.appendChild(sendBtn);

    view.appendChild(headerBar);
    view.appendChild(messageList);
    view.appendChild(inputBar);

    return view;
}

function showEmptyState() {
    if (!messageList) return;
    messageList.innerHTML = `
        <div class="nihongo-chat-empty">
            <i class="fa-solid fa-comments"></i>
            <p>Language Assistant</p>
            <span>Hover a word and click an action, or type a question below.</span>
        </div>
    `;
}

function autoResizeInput() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

/**
 * Opens a popup showing the full prompt as it was/would be sent to the LLM.
 * Shows main system prompt, action instructions, history, and user prompt in readable format.
 */
function showPromptViewer() {
    if (!lastBuiltPrompts) {
        toastr.info('No prompt generated yet. Trigger an action or send a message first.');
        return;
    }

    const history = buildHistoryForLLM();
    const sections = [];
    sections.push(`═══ SYSTEM PROMPT ═══\n${lastBuiltPrompts.mainSystemPrompt}`);
    if (history.length > 0) {
        sections.push(`═══ HISTORY (${history.length} messages) ═══\n${history.map(m => `[${m.role}] ${m.content}`).join('\n\n')}`);
    }
    if (lastBuiltPrompts.actionInstructions) {
        sections.push(`═══ ACTION INSTRUCTIONS (at depth) ═══\n${lastBuiltPrompts.actionInstructions}`);
    }
    sections.push(`═══ USER PROMPT ═══\n${lastBuiltPrompts.userPrompt}`);

    const text = sections.join('\n\n');

    // Use SillyTavern's popup system if available, otherwise a simple overlay
    const overlay = document.createElement('div');
    overlay.className = 'nihongo-prompt-viewer-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const dialog = document.createElement('div');
    dialog.className = 'nihongo-prompt-viewer';

    const header = document.createElement('div');
    header.className = 'nihongo-prompt-viewer-header';
    header.innerHTML = `<span>Full LLM Prompt</span><button class="nihongo-prompt-viewer-close" title="Close"><i class="fa-solid fa-xmark"></i></button>`;
    header.querySelector('button')?.addEventListener('click', () => overlay.remove());

    const content = document.createElement('pre');
    content.className = 'nihongo-prompt-viewer-content';
    content.textContent = text;

    dialog.appendChild(header);
    dialog.appendChild(content);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// ===== Internal: Message Handling =====

function handleSend() {
    if (!inputEl || activeRequest) return;
    const text = inputEl.value.trim();
    if (!text) return;

    ensureSession();

    const userMsg = createMessage('user', text, { context: null });
    addMessage(userMsg);

    inputEl.value = '';
    autoResizeInput();

    // Determine action: if there was recent context, use 'custom' with that context
    const lastContext = getLastContext();
    generateResponse('custom', lastContext, text);
}

/**
 * Gets the context from the most recent action message (for follow-ups).
 * @returns {Object|null}
 */
function getLastContext() {
    if (!currentSession) return null;
    for (let i = currentSession.messages.length - 1; i >= 0; i--) {
        const msg = currentSession.messages[i];
        if (msg.context && msg.context.word) return msg.context;
    }
    return null;
}

/**
 * Sends a request to the LLM and streams the response.
 * Builds prompts, stores them on the user message, and sends to LLM.
 * @param {string} actionId
 * @param {Object|null} context
 * @param {string} [userMessage]
 */
async function generateResponse(actionId, context, userMessage) {
    if (activeRequest) {
        activeRequest.abort();
    }

    const abortController = new AbortController();
    activeRequest = abortController;

    // Build prompts from preset templates + macros
    const prompts = buildPrompts(actionId, context || {}, userMessage);
    lastBuiltPrompts = prompts;

    // Store prompt data on the most recent user message (added by triggerChatAction/handleSend)
    if (currentSession) {
        const lastUserMsg = findLastUserMessage();
        if (lastUserMsg) {
            lastUserMsg.prompt = prompts.userPrompt;
            lastUserMsg.instructions = prompts.actionInstructions;
            lastUserMsg.actionId = actionId;

            // Render system bar + prompt peek now that data is available
            if (messageList && lastUserMsg.instructions) {
                const userEl = messageList.querySelector(`[data-msg-id="${lastUserMsg.id}"]`);
                if (userEl) {
                    // Insert system bar before the user message element
                    const bar = renderSystemBar(lastUserMsg);
                    messageList.insertBefore(bar, userEl);

                    // Add prompt peek button to user message if prompt differs from display
                    if (lastUserMsg.prompt && lastUserMsg.prompt !== lastUserMsg.content) {
                        const contentEl = userEl.querySelector('.nihongo-chat-msg-content');
                        if (contentEl && !contentEl.querySelector('.nihongo-chat-prompt-peek-btn')) {
                            const expandBtn = document.createElement('button');
                            expandBtn.className = 'nihongo-chat-prompt-peek-btn';
                            expandBtn.title = 'Show full prompt sent to LLM';
                            expandBtn.textContent = 'prompt \u25BE';
                            expandBtn.addEventListener('click', () => {
                                const existing = contentEl.querySelector('.nihongo-chat-prompt-peek');
                                if (existing) {
                                    existing.remove();
                                    expandBtn.classList.remove('active');
                                    expandBtn.textContent = 'prompt \u25BE';
                                } else {
                                    const peek = document.createElement('div');
                                    peek.className = 'nihongo-chat-prompt-peek';
                                    peek.textContent = lastUserMsg.prompt;
                                    contentEl.appendChild(peek);
                                    expandBtn.classList.add('active');
                                    expandBtn.textContent = 'prompt \u25B4';
                                }
                            });
                            contentEl.appendChild(expandBtn);
                        }
                    }
                }
            }
        }
    }

    // Create placeholder assistant message
    const assistantMsg = createMessage('assistant', '', { meta: { profileId: nihongoSettings.chatProfileId, model: '', durationMs: null, streamed: false } });
    addMessage(assistantMsg);

    const msgEl = messageList?.querySelector(`[data-msg-id="${assistantMsg.id}"]`);
    streamingMessageEl = msgEl;

    // Show typing indicator
    if (msgEl) msgEl.classList.add('nihongo-chat-msg-streaming');

    const startTime = Date.now();

    try {
        // Build history for multi-turn (uses msg.prompt for user messages)
        const history = buildHistoryForLLM();

        const result = await sendChatRequest({
            mainSystemPrompt: prompts.mainSystemPrompt,
            actionInstructions: prompts.actionInstructions,
            userPrompt: prompts.userPrompt,
            history,
            onStream: (update) => {
                assistantMsg.content = update.text;
                assistantMsg.reasoning = update.reasoning;
                updateMessageEl(msgEl, assistantMsg);
            },
            signal: abortController.signal,
        });

        // Finalize
        assistantMsg.content = result.content;
        assistantMsg.reasoning = result.reasoning;
        const durationMs = Date.now() - startTime;
        assistantMsg.meta = {
            profileId: result.profileId,
            model: result.model,
            durationMs,
            streamed: result.streamed,
        };
        updateMessageEl(msgEl, assistantMsg);
        // Update reasoning header to show elapsed time
        if (msgEl && assistantMsg.reasoning) {
            updateReasoningHeader(msgEl, durationMs);
        }
    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            assistantMsg.content = '*(cancelled)*';
        } else {
            console.error(`[${EXTENSION_NAME}] Side chat error:`, error);
            assistantMsg.content = `*Error: ${error.message || 'Failed to generate response'}*`;
        }
        updateMessageEl(msgEl, assistantMsg);
    } finally {
        if (msgEl) msgEl.classList.remove('nihongo-chat-msg-streaming');
        streamingMessageEl = null;
        if (activeRequest === abortController) activeRequest = null;
    }
}

/**
 * Finds the last user message in the session (for storing prompt data).
 * @returns {ChatMessage|null}
 */
function findLastUserMessage() {
    if (!currentSession) return null;
    for (let i = currentSession.messages.length - 1; i >= 0; i--) {
        if (currentSession.messages[i].role === 'user') return currentSession.messages[i];
    }
    return null;
}

/**
 * Builds conversation history for the LLM.
 * Uses msg.prompt (full text) for user messages, msg.content for assistant messages.
 * Handles action instruction system messages based on chatHistoryMode setting.
 * @returns {Array<{role: string, content: string}>}
 */
function buildHistoryForLLM() {
    if (!currentSession) return [];

    const maxHistory = nihongoSettings.chatMaxHistory;
    const mode = nihongoSettings.chatHistoryMode;
    const keepN = nihongoSettings.chatHistoryKeepN;

    // Get relevant messages — user and assistant with content, no errors
    const relevant = currentSession.messages
        .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content && !m.content.startsWith('*'))
        .slice(-maxHistory);

    // Exclude the latest user message (it becomes the current prompt)
    const msgs = relevant.slice(0, -1);

    const result = [];
    const seenActionIds = new Set();

    for (const msg of msgs) {
        // For user messages, optionally inject the action instructions before them
        if (msg.role === 'user' && msg.instructions && mode !== 'remove') {
            if (mode === 'deduplicate') {
                if (msg.actionId && seenActionIds.has(msg.actionId)) {
                    const action = getChatAction(msg.actionId);
                    result.push({ role: 'system', content: `[Same instructions as '${action?.label || msg.actionId}' above]` });
                } else {
                    if (msg.actionId) seenActionIds.add(msg.actionId);
                    result.push({ role: 'system', content: msg.instructions });
                }
            } else {
                // keep_last_n — add all, trim later
                result.push({ role: 'system', content: msg.instructions, _isInstruction: true });
            }
        }

        // User messages use full prompt text; assistant messages use content
        const content = (msg.role === 'user') ? (msg.prompt || msg.content) : msg.content;
        result.push({ role: msg.role, content });
    }

    // For keep_last_n, strip older system messages beyond keepN
    if (mode === 'keep_last_n') {
        const systemEntries = [];
        result.forEach((r, i) => { if (r.role === 'system') systemEntries.push(i); });
        if (systemEntries.length > keepN) {
            const toRemove = new Set(systemEntries.slice(0, systemEntries.length - keepN));
            return result.filter((_, i) => !toRemove.has(i)).map(({ role, content }) => ({ role, content }));
        }
    }

    return result.map(({ role, content }) => ({ role, content }));
}

// ===== Internal: DOM Rendering =====

/**
 * Adds a message to the session and renders it.
 * @param {ChatMessage} msg
 */
function addMessage(msg) {
    if (!currentSession || !messageList) return;
    currentSession.messages.push(msg);
    currentSession.lastActiveAt = new Date().toISOString();

    // Clear empty state on first message
    const emptyState = messageList.querySelector('.nihongo-chat-empty');
    if (emptyState) emptyState.remove();

    const el = renderMessage(msg);
    messageList.appendChild(el);
    messageList.scrollTop = messageList.scrollHeight;
}

/**
 * Renders a single message as DOM element.
 * @param {ChatMessage} msg
 * @returns {HTMLElement}
 */
function renderMessage(msg) {
    const el = document.createElement('div');
    el.className = `nihongo-chat-msg nihongo-chat-msg-${msg.role}`;
    el.dataset.msgId = msg.id;

    if (msg.role === 'assistant') {
        // Profile icon
        const icon = getProfileIcon(msg.meta?.profileId);
        if (icon) {
            const iconWrap = document.createElement('div');
            iconWrap.className = 'nihongo-chat-msg-icon';
            icon.classList.add('nihongo-chat-profile-icon');
            iconWrap.appendChild(icon);
            el.appendChild(iconWrap);
        }

        const body = document.createElement('div');
        body.className = 'nihongo-chat-msg-body';

        // Reasoning block (collapsible)
        if (msg.reasoning) {
            body.appendChild(buildReasoningBlock(msg.reasoning, !!msg.content));
        }

        // Content
        const contentEl = document.createElement('div');
        contentEl.className = 'nihongo-chat-msg-content';
        contentEl.textContent = msg.content || '';
        body.appendChild(contentEl);

        // Timestamp + model
        const footer = document.createElement('div');
        footer.className = 'nihongo-chat-msg-footer';
        footer.textContent = formatTimestamp(msg.timestamp);
        if (msg.meta?.model) {
            footer.textContent += ` · ${msg.meta.model}`;
        }
        body.appendChild(footer);

        el.appendChild(body);
    } else {
        // User message
        const contentEl = document.createElement('div');
        contentEl.className = 'nihongo-chat-msg-content';
        contentEl.textContent = msg.content;
        el.appendChild(contentEl);

        const footer = document.createElement('div');
        footer.className = 'nihongo-chat-msg-footer';
        footer.textContent = formatTimestamp(msg.timestamp);
        el.appendChild(footer);
    }

    return el;
}

/**
 * Renders a collapsible system instruction bar above a user message.
 * Shows the action label; click to expand/collapse the full instructions.
 * @param {ChatMessage} msg - The user message with instructions data
 * @returns {HTMLElement}
 */
function renderSystemBar(msg) {
    const bar = document.createElement('div');
    bar.className = 'nihongo-chat-system-bar';

    const action = msg.actionId ? getChatAction(msg.actionId) : null;
    const label = action ? action.label : 'System';
    const icon = action ? action.icon : 'fa-gear';

    const header = document.createElement('div');
    header.className = 'nihongo-chat-system-bar-header';
    header.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${label} instructions</span> <i class="fa-solid fa-chevron-right nihongo-chat-system-bar-toggle"></i>`;
    header.addEventListener('click', () => bar.classList.toggle('expanded'));

    const content = document.createElement('div');
    content.className = 'nihongo-chat-system-bar-content';
    content.textContent = msg.instructions;

    bar.appendChild(header);
    bar.appendChild(content);
    return bar;
}

/**
 * Updates an existing message DOM element with new content (for streaming).
 * @param {HTMLElement|null} el
 * @param {ChatMessage} msg
 */
function updateMessageEl(el, msg) {
    if (!el) return;

    const body = el.querySelector('.nihongo-chat-msg-body') || el;

    // Update reasoning
    let reasoningBlock = el.querySelector('.nihongo-chat-reasoning');
    if (msg.reasoning) {
        if (!reasoningBlock) {
            reasoningBlock = buildReasoningBlock(msg.reasoning, !!msg.content);
            const contentEl = body.querySelector('.nihongo-chat-msg-content');
            if (contentEl) body.insertBefore(reasoningBlock, contentEl);
            else body.prepend(reasoningBlock);
        } else {
            const reasoningContent = reasoningBlock.querySelector('.nihongo-chat-reasoning-text');
            if (reasoningContent) {
                reasoningContent.innerHTML = messageFormatting(msg.reasoning, '', false, false, -1, {}, true);
                // Auto-scroll reasoning block while streaming
                reasoningContent.scrollTop = reasoningContent.scrollHeight;
            }
            // Collapse reasoning once content starts arriving
            if (msg.content && !reasoningBlock.classList.contains('collapsed')) {
                reasoningBlock.classList.add('collapsed');
            }
        }
    }

    // Update content with message formatting (markdown, regex, etc.)
    const contentEl = body.querySelector('.nihongo-chat-msg-content');
    if (contentEl) {
        contentEl.innerHTML = msg.content ? messageFormatting(msg.content, '', false, false, -1, {}) : '';
    }

    // Auto-scroll
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
}

/**
 * Builds a collapsible reasoning block.
 * @param {string} reasoning
 * @param {boolean} collapsed - Start collapsed?
 * @returns {HTMLElement}
 */
function buildReasoningBlock(reasoning, collapsed) {
    const block = document.createElement('div');
    block.className = `nihongo-chat-reasoning${collapsed ? ' collapsed' : ''}`;

    const header = document.createElement('div');
    header.className = 'nihongo-chat-reasoning-header';
    header.innerHTML = '<i class="fa-solid fa-brain"></i> <span>Thinking...</span> <i class="fa-solid fa-chevron-down nihongo-chat-reasoning-toggle"></i>';
    header.addEventListener('click', () => block.classList.toggle('collapsed'));

    const content = document.createElement('div');
    content.className = 'nihongo-chat-reasoning-text';
    content.textContent = reasoning;

    block.appendChild(header);
    block.appendChild(content);
    return block;
}

/**
 * Updates the reasoning header from "Thinking..." to "Thought for x seconds".
 * @param {HTMLElement} msgEl
 * @param {number} durationMs
 */
function updateReasoningHeader(msgEl, durationMs) {
    const header = msgEl.querySelector('.nihongo-chat-reasoning-header span');
    if (header) {
        const timeStr = humanizeGenTime(durationMs).toLowerCase();
        header.textContent = `Thought for ${timeStr}`;
    }
}

// ===== Internal: Session Management =====

function ensureSession() {
    if (currentSession) return;
    const now = new Date().toISOString();
    currentSession = {
        id: generateId(),
        createdAt: now,
        lastActiveAt: now,
        messages: [],
        sessionContext: {
            characterName: getCharacterName(),
            userName: getUserName(),
        },
    };
}

// ===== Internal: Utilities =====

/**
 * Creates a new chat message object.
 * @param {'user'|'assistant'|'system'|'action'} role
 * @param {string} content
 * @param {Object} [extras]
 * @returns {ChatMessage}
 */
function createMessage(role, content, extras = {}) {
    return {
        id: generateId(),
        role,
        content,
        prompt: extras.prompt || '',
        instructions: extras.instructions || '',
        actionId: extras.actionId || '',
        reasoning: '',
        timestamp: new Date().toISOString(),
        context: extras.context || null,
        meta: extras.meta || null,
    };
}

/**
 * Formats an action trigger into a user-visible message.
 * @param {Object} action
 * @param {Object} context
 * @returns {string}
 */
function formatActionMessage(action, context) {
    const word = context.word || '';
    return `${action.label}: ${word}`;
}

function formatTimestamp(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getCharacterName() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.name2 || '';
    } catch { return ''; }
}

function getUserName() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.name1 || '';
    } catch { return ''; }
}
