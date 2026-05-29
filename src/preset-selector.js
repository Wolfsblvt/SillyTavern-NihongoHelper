/**
 * Reusable Tutor Preset selector card.
 *
 * Renders the "title + description + searchable select2 dropdown" UI used in
 * both the extension settings panel and the side-chat header. Each mounted
 * instance owns its own DOM and select2 binding; a small registry lets call
 * sites broadcast a refresh after global state changes (preset list mutated,
 * active preset switched, chat changed, etc.).
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ 🎓 Default Tutor                       🔀 🔗 ⬇ ⬆ 🗑       │
 *   │ A concise Japanese language tutor for in-context word and… │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Shuffle (pick) button is always present. Chain and import/export/delete
 * controls are opt-in via mount options. The card is built in JS rather than
 * via an HTML template so multiple instances can coexist without id clashes.
 */

import { getPresetList } from './side-chat-prompts.js';

// ===== Module state =====

/**
 * @typedef {Object} PresetSelectorInstance
 * @property {HTMLElement} container
 * @property {HTMLSelectElement} select
 * @property {() => void} refresh   Re-reads external state and updates the UI.
 * @property {() => void} destroy   Removes from the registry; caller is responsible
 *                                  for detaching the container from the DOM.
 */

/** @type {Set<PresetSelectorInstance>} */
const instances = new Set();

// ===== Public API =====

/**
 * @typedef {Object} ChainOptions
 * @property {() => boolean} isChained             True when the active preset is bound to the current ST chat.
 * @property {() => string|null} getDefaultName    Display name of the user's default preset (for tooltip when chained).
 * @property {() => Promise<void>|void} onToggle   Called when the chain button is clicked.
 *                                                 Implementer is responsible for binding/unbinding and
 *                                                 calling `refreshAllPresetSelectors()`.
 */

/**
 * @typedef {Object} IoOptions
 * @property {(file: File) => Promise<void>|void} onImport  Called with the user-picked JSON file.
 * @property {() => void} onExport
 * @property {() => Promise<void>|void} onDelete
 * @property {() => boolean} canDelete                       Controls visibility of the delete button.
 */

/**
 * @typedef {Object} MountOptions
 * @property {() => string} getActiveId               Returns the preset id this card should display as selected.
 * @property {(id: string) => Promise<void>|void} onSelect  Called when the user picks a different preset.
 *                                                          Should update its own source of truth and call
 *                                                          `refreshAllPresetSelectors()`.
 * @property {string} [icon]                          FA icon class (default: 'fa-graduation-cap').
 * @property {ChainOptions} [chain]                   Chain button (omit to hide).
 * @property {IoOptions} [io]                         Import/export/delete controls (omit to hide).
 */

/**
 * Mounts the preset selector card inside `container`. The container's existing
 * children are wiped — pass an empty placeholder element.
 *
 * @param {HTMLElement} container
 * @param {MountOptions} opts
 * @returns {PresetSelectorInstance}
 */
export function mountPresetSelector(container, opts) {
    container.classList.add('nihongo-preset-selector');
    container.replaceChildren();

    const dom = buildSelectorDom(container, opts);
    populateOptions(dom.select, opts.getActiveId());
    initSelect2(dom.select);

    wireSelectButton(dom);
    wireSelect2Events(dom, opts);
    if (opts.chain) wireChainButton(dom, opts.chain);
    if (opts.io) wireIoButtons(dom, opts.io);

    /** @type {PresetSelectorInstance} */
    const instance = {
        container,
        select: dom.select,
        refresh: () => refreshInstance(dom, opts),
        destroy: () => { instances.delete(instance); },
    };
    instances.add(instance);
    instance.refresh();
    return instance;
}

/**
 * Refreshes every currently-mounted selector card. Call this after any state
 * change that affects multiple instances: preset list mutated (import / delete),
 * active preset switched, chat-binding changed, ST chat switched.
 */
export function refreshAllPresetSelectors() {
    for (const instance of instances) {
        try {
            instance.refresh();
        } catch (err) {
            console.error('[NihongoHelper] preset selector refresh failed:', err);
        }
    }
}

// ===== DOM construction =====

/**
 * @typedef {Object} SelectorDom
 * @property {HTMLElement} container
 * @property {HTMLElement} header
 * @property {HTMLSelectElement} select
 * @property {HTMLElement} titleDisplay
 * @property {HTMLElement} description
 * @property {HTMLElement} selectBtn
 * @property {HTMLElement|null} chainBtn
 * @property {HTMLElement|null} chainIcon
 * @property {HTMLElement|null} importBtn
 * @property {HTMLElement|null} exportBtn
 * @property {HTMLElement|null} deleteBtn
 * @property {HTMLInputElement|null} fileInput
 */

/**
 * @param {HTMLElement} container
 * @param {MountOptions} opts
 * @returns {SelectorDom}
 */
function buildSelectorDom(container, opts) {
    const header = document.createElement('div');
    header.className = 'nihongo-preset-selector-header';

    const iconEl = document.createElement('i');
    iconEl.className = `fa-solid ${opts.icon || 'fa-graduation-cap'} nihongo-preset-selector-icon`;

    const titleDisplay = document.createElement('span');
    titleDisplay.className = 'nihongo-preset-selector-title-display';

    const dropdownWrapper = document.createElement('div');
    dropdownWrapper.className = 'nihongo-preset-selector-dropdown-wrapper';

    const select = document.createElement('select');
    select.className = 'nihongo-preset-selector-dropdown';
    dropdownWrapper.appendChild(select);

    const controls = document.createElement('div');
    controls.className = 'nihongo-preset-selector-controls';

    const selectBtn = document.createElement('div');
    selectBtn.className = 'nihongo-preset-selector-select-btn menu_button menu_button_icon';
    selectBtn.title = 'Select preset';
    selectBtn.innerHTML = '<i class="fa-solid fa-shuffle"></i>';
    controls.appendChild(selectBtn);

    /** @type {HTMLElement|null} */
    let chainBtn = null;
    /** @type {HTMLElement|null} */
    let chainIcon = null;
    if (opts.chain) {
        chainBtn = document.createElement('div');
        chainBtn.className = 'nihongo-preset-selector-chain-btn menu_button menu_button_icon';
        chainIcon = document.createElement('i');
        chainIcon.className = 'fa-solid fa-link-slash';
        chainBtn.appendChild(chainIcon);
        controls.appendChild(chainBtn);
    }

    /** @type {HTMLElement|null} */
    let importBtn = null;
    /** @type {HTMLElement|null} */
    let exportBtn = null;
    /** @type {HTMLElement|null} */
    let deleteBtn = null;
    /** @type {HTMLInputElement|null} */
    let fileInput = null;
    if (opts.io) {
        importBtn = makeIconButton('fa-file-import', 'Import preset from a JSON file');
        exportBtn = makeIconButton('fa-file-export', 'Export the active preset as JSON');
        deleteBtn = makeIconButton('fa-trash', 'Delete this imported preset');
        deleteBtn.style.display = 'none';
        controls.append(importBtn, exportBtn, deleteBtn);

        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'application/json,.json';
        fileInput.style.display = 'none';
    }

    header.append(iconEl, titleDisplay, dropdownWrapper, controls);

    const description = document.createElement('div');
    description.className = 'nihongo-preset-selector-description';

    container.append(header, description);
    if (fileInput) container.append(fileInput);

    return {
        container, header, select, titleDisplay, description,
        selectBtn, chainBtn, chainIcon,
        importBtn, exportBtn, deleteBtn, fileInput,
    };
}

/**
 * @param {string} faIcon
 * @param {string} title
 * @returns {HTMLButtonElement}
 */
function makeIconButton(faIcon, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu_button menu_button_icon';
    btn.title = title;
    btn.innerHTML = `<i class="fa-solid ${faIcon}"></i>`;
    return btn;
}

// ===== select2 wiring =====

/**
 * (Re)populates the underlying `<select>` with the current preset list and
 * sets the active option. Keeps select2 (if already bound) in sync via
 * `change.select2`.
 *
 * @param {HTMLSelectElement} select
 * @param {string} [desiredId] Preset id to select. Falls back to the first
 *   option when missing or unknown.
 */
function populateOptions(select, desiredId) {
    select.replaceChildren();

    const presets = getPresetList();
    for (const preset of presets) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.name;
        if (preset.description) opt.title = preset.description;
        select.appendChild(opt);
    }

    if (desiredId && presets.some(p => p.id === desiredId)) {
        select.value = desiredId;
    } else if (presets.length > 0) {
        select.value = presets[0].id;
    }

    // @ts-ignore — select2 is a global jQuery plugin in SillyTavern.
    if ($(select).data('select2')) $(select).trigger('change.select2');
}

/**
 * Binds select2 to the underlying `<select>` with custom matcher and rich
 * option rendering. Idempotent — bails out if already bound.
 *
 * @param {HTMLSelectElement} select
 */
function initSelect2(select) {
    // @ts-ignore
    const $select = $(select);
    // @ts-ignore
    if ($select.data('select2')) return;

    // @ts-ignore
    $select.select2({
        width: '100%',
        dropdownAutoWidth: true,
        matcher: select2Matcher,
        templateResult: select2TemplateResult,
        templateSelection: (state) => state.text,
    });
}

/**
 * @param {SelectorDom} dom
 */
function wireSelectButton(dom) {
    dom.selectBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSelecting(dom, true);
    });
}

/**
 * @param {SelectorDom} dom
 * @param {MountOptions} opts
 */
function wireSelect2Events(dom, opts) {
    // @ts-ignore
    const $select = $(dom.select);

    // @ts-ignore
    $select.on('select2:select', async (e) => {
        const id = String(e.params.data.id);
        toggleSelecting(dom, false);
        await opts.onSelect(id);
        // The onSelect implementer is responsible for global state updates and
        // should call refreshAllPresetSelectors(). Refresh ourselves locally
        // so even an implementer that forgets at least syncs this card.
        refreshInstance(dom, opts);
    });

    // @ts-ignore
    $select.on('select2:close', () => toggleSelecting(dom, false));
}

/**
 * @param {SelectorDom} dom
 * @param {ChainOptions} chain
 */
function wireChainButton(dom, chain) {
    if (!dom.chainBtn) return;
    dom.chainBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await chain.onToggle();
        // Implementer should refresh globally; do a local refresh as a safety
        // net so the chain icon flips even on partial failures upstream.
    });
}

/**
 * @param {SelectorDom} dom
 * @param {IoOptions} io
 */
function wireIoButtons(dom, io) {
    if (dom.importBtn && dom.fileInput) {
        const fileInput = dom.fileInput;
        dom.importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            // Reset value so re-importing the same file fires `change` again.
            fileInput.value = '';
            if (!file) return;
            await io.onImport(file);
        });
    }
    if (dom.exportBtn) {
        dom.exportBtn.addEventListener('click', () => io.onExport());
    }
    if (dom.deleteBtn) {
        dom.deleteBtn.addEventListener('click', async () => await io.onDelete());
    }
}

// ===== select2 helpers =====

/**
 * Matches preset entries by substring against name + description (case-insensitive).
 * Empty term keeps everything. Typed as `any` because select2's official typings
 * model option/optgroup data more strictly than we need here.
 *
 * @param {any} params
 * @param {any} data
 * @returns {any}
 */
function select2Matcher(params, data) {
    if (!params.term || !params.term.trim()) return data;
    if (!data || !data.id) return null;
    const term = params.term.trim().toLowerCase();
    const preset = getPresetList().find(p => p.id === data.id);
    if (!preset) return null;
    const haystack = `${preset.name} ${preset.description || ''}`.toLowerCase();
    return haystack.includes(term) ? data : null;
}

/**
 * Renders a select2 option as a two-line block (title + description) with a
 * "Bundled" badge for shipped presets.
 *
 * @param {any} state
 * @returns {any}
 */
function select2TemplateResult(state) {
    if (!state.id) return state.text || '';
    const preset = getPresetList().find(p => p.id === state.id);
    if (!preset) return state.text || '';

    const wrapper = document.createElement('div');
    wrapper.classList.add('nihongo-preset-selector-option');

    const titleDiv = document.createElement('div');
    titleDiv.classList.add('nihongo-preset-selector-option-title');
    titleDiv.append(document.createTextNode(preset.name));
    if (preset.bundled) {
        const badge = document.createElement('span');
        badge.classList.add('nihongo-preset-selector-option-badge');
        badge.textContent = 'Bundled';
        titleDiv.appendChild(badge);
    }
    wrapper.appendChild(titleDiv);

    if (preset.description) {
        const descDiv = document.createElement('div');
        descDiv.classList.add('nihongo-preset-selector-option-desc');
        descDiv.textContent = preset.description;
        wrapper.appendChild(descDiv);
    }

    // @ts-ignore — select2 expects a jQuery wrapper for templateResult.
    return $(wrapper);
}

// ===== State sync =====

/**
 * Toggles "selecting" mode on the card and opens/closes select2.
 *
 * @param {SelectorDom} dom
 * @param {boolean} open
 */
function toggleSelecting(dom, open) {
    dom.container.classList.toggle('selecting', open);
    // @ts-ignore
    if ($(dom.select).data('select2')) {
        // @ts-ignore
        if (open) $(dom.select).select2('open');
        // @ts-ignore
        else $(dom.select).select2('close');
    }
}

/**
 * Re-reads external state via `opts.getActiveId()` / chain / io callbacks
 * and updates the card's title, description, chain button, delete-button
 * visibility, and the underlying `<select>` value.
 *
 * Also rebuilds the option list from the latest preset list so import / delete
 * mutations are reflected.
 *
 * @param {SelectorDom} dom
 * @param {MountOptions} opts
 */
function refreshInstance(dom, opts) {
    const id = opts.getActiveId();
    populateOptions(dom.select, id);

    const preset = getPresetList().find(p => p.id === id);
    dom.titleDisplay.textContent = preset?.name || id || '';
    dom.description.textContent = preset?.description || '';

    if (dom.chainBtn && dom.chainIcon && opts.chain) {
        const chained = !!opts.chain.isChained();
        dom.chainBtn.classList.toggle('chained', chained);
        // Solid link when chained, slashed-link when free.
        dom.chainIcon.className = `fa-solid ${chained ? 'fa-link' : 'fa-link-slash'}`;
        const defaultName = opts.chain.getDefaultName();
        dom.chainBtn.title = chained
            ? (defaultName
                ? `Pinned to this chat — click to revert to default (${defaultName})`
                : 'Pinned to this chat — click to revert to default')
            : 'Pin this tutor to the current chat';
    }

    if (dom.deleteBtn && opts.io) {
        dom.deleteBtn.style.display = opts.io.canDelete() ? '' : 'none';
    }

    dom.container.classList.toggle('chained', !!(opts.chain && opts.chain.isChained()));
}
