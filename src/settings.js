import { saveSettingsDebounced, eventSource } from '../../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../../extensions.js';
import { event_types } from '../../../../events.js';
import { EXTENSION_KEY, EXTENSION_NAME } from '../index.js';
import { getPresetList, loadPreset } from './side-chat-prompts.js';

/** @readonly Default settings values */
const defaultSettings = {
    enabled: true,
    hoverOnly: false,
    highlightKnown: true,
    fontSize: 1.0,
    furiganaScale: 0.75,
    kmSort: 'freq_asc',
    kmFilter: 'all',
    meaningSpoiler: 'off',
    hideKnownFurigana: true,
    kanaWordTooltips: false,
    lookupWindowSize: 5,
    selectionLookup: true,
    panelSide: 'right',
    chatProfileId: '',
    chatPresetId: 'default',
    chatHistoryMode: 'remove',
    chatHistoryKeepN: 3,
    chatMaxHistory: 20,
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
    get panelSide() {
        return String(ensureSettings().panelSide || 'right');
    },
    set panelSide(val) {
        ensureSettings().panelSide = val;
        saveSettingsDebounced();
    },
    get chatProfileId() {
        return String(ensureSettings().chatProfileId || '');
    },
    set chatProfileId(val) {
        ensureSettings().chatProfileId = val;
        saveSettingsDebounced();
    },
    get chatPresetId() {
        return String(ensureSettings().chatPresetId || 'default');
    },
    set chatPresetId(val) {
        ensureSettings().chatPresetId = val;
        saveSettingsDebounced();
    },
    get chatHistoryMode() {
        return String(ensureSettings().chatHistoryMode || 'remove');
    },
    set chatHistoryMode(val) {
        ensureSettings().chatHistoryMode = val;
        saveSettingsDebounced();
    },
    get chatHistoryKeepN() {
        return Number(ensureSettings().chatHistoryKeepN) || 3;
    },
    set chatHistoryKeepN(val) {
        ensureSettings().chatHistoryKeepN = val;
        saveSettingsDebounced();
    },
    get chatMaxHistory() {
        return Number(ensureSettings().chatMaxHistory) || 20;
    },
    set chatMaxHistory(val) {
        ensureSettings().chatMaxHistory = val;
        saveSettingsDebounced();
    },
    /** Gets known kanji count (reads from extension_settings directly) */
    get knownKanjiCount() {
        const known = extension_settings[EXTENSION_KEY]?.knownKanji;
        return known ? Object.keys(known).length : 0;
    },
    /** Gets comma-separated known kanji string */
    get knownKanji() {
        const known = extension_settings[EXTENSION_KEY]?.knownKanji;
        return known ? Object.keys(known).join(',') : '';
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

    const panelSideSelect = document.getElementById('nihongo_helper_panel_side');
    if (panelSideSelect instanceof HTMLSelectElement) {
        panelSideSelect.value = settings.panelSide;
    }

    const historyModeSelect = document.getElementById('nihongo_helper_history_mode');
    if (historyModeSelect instanceof HTMLSelectElement) {
        historyModeSelect.value = settings.chatHistoryMode;
    }
    // Show/hide keep-N row based on mode
    const keepNRow = document.getElementById('nihongo_helper_keep_n_row');
    if (keepNRow) keepNRow.style.display = settings.chatHistoryMode === 'keep_last_n' ? '' : 'none';

    const keepNInput = document.getElementById('nihongo_helper_keep_n');
    if (keepNInput instanceof HTMLInputElement) keepNInput.value = String(settings.chatHistoryKeepN);
    const keepNValue = document.getElementById('nihongo_helper_keep_n_value');
    if (keepNValue) keepNValue.textContent = String(settings.chatHistoryKeepN);

    const maxHistoryInput = document.getElementById('nihongo_helper_max_history');
    if (maxHistoryInput instanceof HTMLInputElement) maxHistoryInput.value = String(settings.chatMaxHistory);
    const maxHistoryValue = document.getElementById('nihongo_helper_max_history_value');
    if (maxHistoryValue) maxHistoryValue.textContent = String(settings.chatMaxHistory);

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
            document.getElementById('chat')?.classList.toggle('nihongo-kana-tooltips', settings.kanaWordTooltips);
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

    document.getElementById('nihongo_helper_panel_side')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) {
            settings.panelSide = e.target.value;
            saveSettingsDebounced();
            if (_onPanelSideChange) _onPanelSideChange(e.target.value);
        }
    });

    // Chat profile selector
    const chatProfileSelect = document.getElementById('nihongo_helper_chat_profile');
    if (chatProfileSelect instanceof HTMLSelectElement) {
        populateChatProfiles(chatProfileSelect);
        chatProfileSelect.addEventListener('change', () => {
            settings.chatProfileId = chatProfileSelect.value;
            saveSettingsDebounced();
        });

        // Re-populate when connection profiles change
        const refreshProfiles = () => populateChatProfiles(chatProfileSelect);
        eventSource.on(event_types.CONNECTION_PROFILE_LOADED, refreshProfiles);
        eventSource.on(event_types.CONNECTION_PROFILE_CREATED, refreshProfiles);
        eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, refreshProfiles);
        eventSource.on(event_types.CONNECTION_PROFILE_DELETED, refreshProfiles);
    }

    // Tutor preset selector
    const presetSelect = document.getElementById('nihongo_helper_tutor_preset');
    if (presetSelect instanceof HTMLSelectElement) {
        populatePresets(presetSelect);
        presetSelect.addEventListener('change', async () => {
            settings.chatPresetId = presetSelect.value;
            saveSettingsDebounced();
            await loadPreset(presetSelect.value);
        });
    }

    // History mode selector
    document.getElementById('nihongo_helper_history_mode')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) {
            settings.chatHistoryMode = e.target.value;
            saveSettingsDebounced();
            const keepNRow = document.getElementById('nihongo_helper_keep_n_row');
            if (keepNRow) keepNRow.style.display = e.target.value === 'keep_last_n' ? '' : 'none';
        }
    });

    document.getElementById('nihongo_helper_keep_n')?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.chatHistoryKeepN = parseInt(e.target.value, 10);
            saveSettingsDebounced();
            const display = document.getElementById('nihongo_helper_keep_n_value');
            if (display) display.textContent = String(settings.chatHistoryKeepN);
        }
    });

    document.getElementById('nihongo_helper_max_history')?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) {
            settings.chatMaxHistory = parseInt(e.target.value, 10);
            saveSettingsDebounced();
            const display = document.getElementById('nihongo_helper_max_history_value');
            if (display) display.textContent = String(settings.chatMaxHistory);
        }
    });

}

/**
 * Populates the chat profile dropdown with available Connection Manager profiles.
 * @param {HTMLSelectElement} select
 */
function populateChatProfiles(select) {
    const currentValue = select.value || ensureSettings().chatProfileId || '';

    // Keep the default option, remove the rest
    while (select.options.length > 1) {
        select.remove(1);
    }

    try {
        const context = SillyTavern.getContext();
        if (context.extensionSettings?.disabledExtensions?.includes('connection-manager')) return;
        const profiles = context.extensionSettings?.connectionManager?.profiles || [];
        for (const profile of profiles) {
            const opt = document.createElement('option');
            opt.value = profile.id;
            opt.textContent = profile.name || profile.id;
            select.appendChild(opt);
        }
    } catch { /* Connection Manager not available */ }

    // Restore selection
    select.value = currentValue;
    if (!select.value && currentValue) {
        // Profile no longer exists — reset
        select.value = '';
    }
}

/**
 * Populates the tutor preset dropdown with discovered presets.
 * @param {HTMLSelectElement} select
 */
function populatePresets(select) {
    const currentValue = select.value || ensureSettings().chatPresetId || 'default';

    // Clear all options
    select.innerHTML = '';

    const presets = getPresetList();
    for (const preset of presets) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.name;
        if (preset.description) opt.title = preset.description;
        select.appendChild(opt);
    }

    select.value = currentValue;
    if (!select.value) select.value = 'default';
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
/** @type {((side: string) => void)|null} */
let _onPanelSideChange = null;

/**
 * Registers a callback for when the panel side setting changes.
 * @param {(side: string) => void} fn
 */
export function onPanelSideChange(fn) {
    _onPanelSideChange = fn;
}

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
        chatEl.classList.toggle('nihongo-kana-tooltips', nihongoSettings.kanaWordTooltips);
    }

    uiInjected = true;
}
