import { initSettings, injectSettingsUI } from './src/settings.js';
import { initFurigana } from './src/furigana.js';
import { initKanjiManager } from './src/kanji-manager.js';
import { loadKanjiState } from './src/kanji-state.js';
import { injectWandMenu } from './src/wand-menu.js';
import { registerInspectShortcut, enableSelectionLookup } from './src/kanji-tooltip.js';
import { registerMacros } from './src/macros.js';
import { initMeaningProvider } from './src/meaning-provider.js';
import { loadTracking } from './src/tracking.js';
import { loadFrequencyData } from './src/frequency.js';
import { initDictSearchUI } from './src/dict-search-ui.js';
import { initSideChat } from './src/side-chat.js';
import { initFeedbackMessages } from './src/feedback-messages.js';
import { initDraftReview } from './src/feedback-draft.js';
import {
    initPresets,
    loadPreset,
    getActivePresetId,
    getEffectivePresetId,
} from './src/side-chat-prompts.js';
import { refreshAllPresetSelectors } from './src/preset-selector.js';
import { registerSearchShortcut } from './src/side-panel.js';
import { eventSource } from '../../../../script.js';
import { event_types } from '../../../events.js';

export const EXTENSION_KEY = 'nihongo_helper';
export const EXTENSION_NAME = 'SillyTavern-NihongoHelper';

let initializeCalled = false;
export let initialized = false;

/**
 * Extension initialization
 */
export async function init() {
    if (initializeCalled) return;
    initializeCalled = true;

    console.debug(`[${EXTENSION_NAME}] Initializing...`);

    // Initialize settings
    initSettings();

    // Load unified kanji state (known/learning) and migrate legacy data
    // BEFORE any consumer (furigana, macros, tooltip) reads it.
    loadKanjiState();

    // Initialize prompt presets (discover + load active preset).
    // Awaited BEFORE the settings UI is injected so the preset dropdown
    // is populated with imported user presets on first render, and so the
    // side-chat action registry is ready before any tooltip can fire.
    //
    // `getEffectivePresetId()` checks `chat_metadata` first (per-chat binding)
    // and falls back to the user's default in extension settings, so a chat
    // pinned to a specific tutor will load it on extension activation if the
    // ST chat is already populated by then.
    await initPresets(getEffectivePresetId());

    await injectSettingsUI();

    // Re-evaluate the effective preset whenever the ST chat changes — a new
    // chat may have its own binding (or none, falling back to the default).
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Initialize furigana processing
    await initFurigana();

    // Initialize kanji manager
    initKanjiManager();

    // Register side panel tabs (must come before wand menu)
    initDictSearchUI();
    initSideChat();

    // Writing Feedback: per-message action button, attached cards, auto mode.
    initFeedbackMessages();
    // Writing Feedback: "Review Japanese" composer button + draft-review modal.
    initDraftReview();

    // Add wand menu items
    injectWandMenu();

    // Register keyboard shortcuts
    registerInspectShortcut();
    registerSearchShortcut();

    // Enable persistent selection lookup (works without inspect mode)
    enableSelectionLookup();

    // Register macros ({{knownKanji}}, {{knownKanjiCount}})
    registerMacros();

    // Load meaning providers (JMdict) in background
    initMeaningProvider();

    // Load word tracking data in background
    loadTracking();

    // Load frequency data in background (optional — only if built)
    loadFrequencyData();

    console.debug(`[${EXTENSION_NAME}] Extension activated`);

    initialized = true;
}

/**
 * CHAT_CHANGED handler. The new ST chat may pin its own tutor preset (in
 * `chat_metadata`) — switch to that, otherwise fall back to the user's
 * default. No-op when the effective preset matches what's already loaded
 * so we avoid an unnecessary `fetch()` on every chat switch.
 */
async function onChatChanged() {
    const effective = getEffectivePresetId();
    if (effective !== getActivePresetId()) {
        await loadPreset(effective);
    }
    // Always refresh selectors so the chain button + title reflect the new
    // chat's binding state, even when the preset itself didn't change.
    refreshAllPresetSelectors();
}
