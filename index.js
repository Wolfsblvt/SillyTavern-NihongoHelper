import { initSettings, injectSettingsUI } from './src/settings.js';
import { initFurigana } from './src/furigana.js';
import { initKanjiManager } from './src/kanji-manager.js';
import { injectWandMenu } from './src/wand-menu.js';
import { registerInspectShortcut, enableSelectionLookup } from './src/kanji-tooltip.js';
import { registerMacros } from './src/macros.js';
import { initMeaningProvider } from './src/meaning-provider.js';
import { loadTracking } from './src/tracking.js';
import { loadFrequencyData } from './src/frequency.js';

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
    await injectSettingsUI();

    // Initialize furigana processing
    await initFurigana();

    // Initialize kanji manager
    initKanjiManager();

    // Add wand menu items
    injectWandMenu();

    // Register keyboard shortcuts
    registerInspectShortcut();

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
