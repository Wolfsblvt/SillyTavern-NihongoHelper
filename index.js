import { initSettings, injectSettingsUI } from './src/settings.js';
import { initFurigana } from './src/furigana.js';

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

    console.debug(`[${EXTENSION_NAME}] Extension activated`);

    initialized = true;
}
