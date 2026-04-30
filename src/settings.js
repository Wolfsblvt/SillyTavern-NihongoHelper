import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../../extensions.js';
import { EXTENSION_KEY, EXTENSION_NAME } from '../index.js';

/** @readonly Default settings values */
const defaultSettings = {
    enabled: true,
    hoverOnly: false,
    highlightKnown: true,
    fontSize: 1.0,
    furiganaScale: 0.75,
    streamInterval: 150,
    kmSort: 'freq_asc',
    kmFilter: 'all',
    meaningSpoiler: 'off',
    hideKnownFurigana: true,
    kanaWordTooltips: false,
    lookupWindowSize: 5,
    selectionLookup: true,
};

let uiInjected = false;

/**
 * Ensures extension settings exist with default values.
 * @returns {typeof defaultSettings}
 */
function ensureSettings() {
    extension_settings[EXTENSION_KEY] = extension_settings[EXTENSION_KEY] || {};

    const settings = extension_settings[EXTENSION_KEY];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!(key in settings)) {
            settings[key] = value;
        }
    }

    return settings;
}

/**
 * Exported settings object with getters for easy access.
 */
export const nihongoSettings = {
    get enabled() {
        return Boolean(ensureSettings().enabled);
    },
    get hoverOnly() {
        return Boolean(ensureSettings().hoverOnly);
    },
    get fontSize() {
        return Number(ensureSettings().fontSize) || 1.0;
    },
    get furiganaScale() {
        return Number(ensureSettings().furiganaScale) || 0.75;
    },
    get streamInterval() {
        return Number(ensureSettings().streamInterval) || 150;
    },
    get highlightKnown() {
        return Boolean(ensureSettings().highlightKnown);
    },
    get kmSort() {
        return String(ensureSettings().kmSort || 'freq_asc');
    },
    set kmSort(val) {
        ensureSettings().kmSort = val;
        saveSettingsDebounced();
    },
    get kmFilter() {
        return String(ensureSettings().kmFilter || 'all');
    },
    set kmFilter(val) {
        ensureSettings().kmFilter = val;
        saveSettingsDebounced();
    },
    get meaningSpoiler() {
        return String(ensureSettings().meaningSpoiler || 'off');
    },
    get hideKnownFurigana() {
        return Boolean(ensureSettings().hideKnownFurigana);
    },
    get kanaWordTooltips() {
        return Boolean(ensureSettings().kanaWordTooltips);
    },
    get lookupWindowSize() {
        return Number(ensureSettings().lookupWindowSize) || 5;
    },
    get selectionLookup() {
        return Boolean(ensureSettings().selectionLookup);
    },
};

/**
 * Applies CSS custom properties for font size and furigana scale.
 */
function applyCSSVariables() {
    const chatEl = document.getElementById('chat');
    if (chatEl) {
        chatEl.style.setProperty('--nihongo-font-size', `${nihongoSettings.fontSize}`);
        chatEl.style.setProperty('--nihongo-furigana-scale', `${nihongoSettings.furiganaScale}`);
    }
}

/**
 * Applies settings to UI elements.
 */
function applySettingsToUI() {
    const settings = ensureSettings();

    const enabledToggle = document.getElementById('nihongo_helper_enabled');
    if (enabledToggle instanceof HTMLInputElement) {
        enabledToggle.checked = settings.enabled;
    }

    const hoverOnlyToggle = document.getElementById('nihongo_helper_hover_only');
    if (hoverOnlyToggle instanceof HTMLInputElement) {
        hoverOnlyToggle.checked = settings.hoverOnly;
    }

    const highlightKnownToggle = document.getElementById('nihongo_helper_highlight_known');
    if (highlightKnownToggle instanceof HTMLInputElement) {
        highlightKnownToggle.checked = settings.highlightKnown;
    }

    const fontSizeInput = document.getElementById('nihongo_helper_font_size');
    if (fontSizeInput instanceof HTMLInputElement) {
        fontSizeInput.value = String(settings.fontSize);
    }
    const fontSizeValue = document.getElementById('nihongo_helper_font_size_value');
    if (fontSizeValue) {
        fontSizeValue.textContent = `${settings.fontSize}x`;
    }

    const furiganaScaleInput = document.getElementById('nihongo_helper_furigana_scale');
    if (furiganaScaleInput instanceof HTMLInputElement) {
        furiganaScaleInput.value = String(settings.furiganaScale);
    }
    const furiganaScaleValue = document.getElementById('nihongo_helper_furigana_scale_value');
    if (furiganaScaleValue) {
        furiganaScaleValue.textContent = `${settings.furiganaScale}x`;
    }

    const streamIntervalInput = document.getElementById('nihongo_helper_stream_interval');
    if (streamIntervalInput instanceof HTMLInputElement) {
        streamIntervalInput.value = String(settings.streamInterval);
    }
    const streamIntervalValue = document.getElementById('nihongo_helper_stream_interval_value');
    if (streamIntervalValue) {
        streamIntervalValue.textContent = `${settings.streamInterval}ms`;
    }

    const spoilerSelect = document.getElementById('nihongo_helper_meaning_spoiler');
    if (spoilerSelect instanceof HTMLSelectElement) {
        spoilerSelect.value = settings.meaningSpoiler;
    }

    const selectionLookupToggle = document.getElementById('nihongo_helper_selection_lookup');
    if (selectionLookupToggle instanceof HTMLInputElement) {
        selectionLookupToggle.checked = settings.selectionLookup;
    }

    const hideKnownFuriganaToggle = document.getElementById('nihongo_helper_hide_known_furigana');
    if (hideKnownFuriganaToggle instanceof HTMLInputElement) {
        hideKnownFuriganaToggle.checked = settings.hideKnownFurigana;
    }

    const kanaWordTooltipsToggle = document.getElementById('nihongo_helper_kana_word_tooltips');
    if (kanaWordTooltipsToggle instanceof HTMLInputElement) {
        kanaWordTooltipsToggle.checked = settings.kanaWordTooltips;
    }

    const lookupWindowInput = document.getElementById('nihongo_helper_lookup_window');
    if (lookupWindowInput instanceof HTMLInputElement) {
        lookupWindowInput.value = String(settings.lookupWindowSize);
    }
    const lookupWindowValue = document.getElementById('nihongo_helper_lookup_window_value');
    if (lookupWindowValue) {
        lookupWindowValue.textContent = String(settings.lookupWindowSize);
    }

    applyCSSVariables();
}

/**
 * Registers event listeners for settings UI.
 */
function registerSettingsEventListeners() {
    const settings = ensureSettings();

    document.getElementById('nihongo_helper_enabled')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.enabled = e.target.checked;
            saveSettingsDebounced();
            document.getElementById('chat')?.classList.toggle('nihongo-furigana-disabled', !settings.enabled);
        }
    });

    document.getElementById('nihongo_helper_hover_only')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.hoverOnly = e.target.checked;
            saveSettingsDebounced();
            document.getElementById('chat')?.classList.toggle('nihongo-furigana-hover', settings.hoverOnly);
        }
    });

    document.getElementById('nihongo_helper_highlight_known')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.highlightKnown = e.target.checked;
            saveSettingsDebounced();
            document.getElementById('chat')?.classList.toggle('nihongo-highlight-known', settings.highlightKnown);
        }
    });

    document.getElementById('nihongo_helper_font_size')?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.fontSize = parseFloat(e.target.value);
            saveSettingsDebounced();
            const display = document.getElementById('nihongo_helper_font_size_value');
            if (display) display.textContent = `${settings.fontSize}x`;
            applyCSSVariables();
        }
    });

    document.getElementById('nihongo_helper_furigana_scale')?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.furiganaScale = parseFloat(e.target.value);
            saveSettingsDebounced();
            const display = document.getElementById('nihongo_helper_furigana_scale_value');
            if (display) display.textContent = `${settings.furiganaScale}x`;
            applyCSSVariables();
        }
    });

    document.getElementById('nihongo_helper_stream_interval')?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.streamInterval = parseInt(e.target.value, 10);
            saveSettingsDebounced();
            const display = document.getElementById('nihongo_helper_stream_interval_value');
            if (display) display.textContent = `${settings.streamInterval}ms`;
        }
    });

    document.getElementById('nihongo_helper_meaning_spoiler')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) {
            settings.meaningSpoiler = e.target.value;
            saveSettingsDebounced();
        }
    });

    document.getElementById('nihongo_helper_selection_lookup')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.selectionLookup = e.target.checked;
            saveSettingsDebounced();
        }
    });

    document.getElementById('nihongo_helper_hide_known_furigana')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.hideKnownFurigana = e.target.checked;
            saveSettingsDebounced();
        }
    });

    document.getElementById('nihongo_helper_kana_word_tooltips')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.kanaWordTooltips = e.target.checked;
            saveSettingsDebounced();
        }
    });

    document.getElementById('nihongo_helper_lookup_window')?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.lookupWindowSize = parseInt(e.target.value, 10);
            saveSettingsDebounced();
            const display = document.getElementById('nihongo_helper_lookup_window_value');
            if (display) display.textContent = String(settings.lookupWindowSize);
        }
    });

}

/**
 * Initializes extension settings with defaults.
 */
export function initSettings() {
    ensureSettings();
}

/**
 * Injects the extension settings UI into the settings panel.
 */
export async function injectSettingsUI() {
    if (uiInjected || document.getElementById('extension_settings_nihongo_helper')) {
        return;
    }

    const col2 = document.getElementById('extensions_settings2');
    const col1 = document.getElementById('extensions_settings');
    const parent = col2 && col1 ? (col2.children.length > col1.children.length ? col1 : col2) : (col2 || col1);

    if (!parent) {
        console.error(`[${EXTENSION_NAME}] Could not find settings container`);
        return;
    }

    const html = await renderExtensionTemplateAsync(`third-party/${EXTENSION_NAME}`, 'templates/settings');
    const template = document.createElement('template');
    template.innerHTML = html;
    parent.appendChild(template.content);

    applySettingsToUI();
    registerSettingsEventListeners();

    // Apply initial CSS classes
    const chatEl = document.getElementById('chat');
    if (chatEl) {
        chatEl.classList.toggle('nihongo-furigana-disabled', !nihongoSettings.enabled);
        chatEl.classList.toggle('nihongo-furigana-hover', nihongoSettings.hoverOnly);
        chatEl.classList.toggle('nihongo-highlight-known', nihongoSettings.highlightKnown);
    }

    uiInjected = true;
}
