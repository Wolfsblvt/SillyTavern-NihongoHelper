import { EXTENSION_NAME } from '../index.js';

/**
 * Shared side panel — VSCode-style tabbed container on the right side.
 *
 * Provides a panel shell that slides in from the right. Different views
 * (Search, Chat, etc.) register as tabs and provide their own content.
 * Only one tab is visible at a time.
 *
 * Usage:
 *   registerTab('search', { icon: 'fa-magnifying-glass', label: 'Search', build: fn })
 *   openSidePanel('search')
 *   closeSidePanel()
 */

// ===== State =====

/** @type {HTMLElement|null} */
let panelEl = null;
let isOpen = false;

/** @type {Map<string, TabDef>} */
const tabs = new Map();
let activeTab = '';

/** Saved cursor position in chat input, restored on close */
let savedSelectionStart = null;
let savedSelectionEnd = null;

/**
 * @typedef {Object} TabDef
 * @property {string} id
 * @property {string} icon FontAwesome class (e.g. 'fa-magnifying-glass')
 * @property {string} label Display label
 * @property {function(): HTMLElement} build Called once to create view content
 * @property {function(): void} [onActivate] Called each time tab becomes active
 * @property {function(): void} [onDeactivate] Called when switching away
 * @property {HTMLElement} [_view] Cached built view
 * @property {HTMLElement} [_tabBtn] Tab button reference
 */

// ===== Public API =====

/**
 * Registers a tab in the side panel.
 * Call during init, before any openSidePanel call.
 * @param {string} id Unique tab id
 * @param {Omit<TabDef, 'id'|'_view'|'_tabBtn'>} def
 */
export function registerTab(id, def) {
    tabs.set(id, { id, ...def });
}

/**
 * Opens the side panel, optionally switching to a specific tab.
 * @param {string} [tabId] Tab to activate (default: first registered or last active)
 */
export function openSidePanel(tabId) {
    ensurePanel();
    saveCursorPosition();

    if (tabId && tabs.has(tabId)) {
        activateTab(tabId);
    } else if (!activeTab && tabs.size > 0) {
        activateTab(tabs.keys().next().value);
    }

    if (!isOpen) {
        isOpen = true;
        panelEl.classList.add('open');
    }
}

/**
 * Closes the side panel.
 */
export function closeSidePanel() {
    if (!isOpen || !panelEl) return;
    isOpen = false;
    panelEl.classList.remove('open');
    restoreCursorPosition();
}

/**
 * Toggles the side panel. If opening, activates the given tab.
 * @param {string} [tabId]
 */
export function toggleSidePanel(tabId) {
    if (isOpen && (!tabId || tabId === activeTab)) {
        closeSidePanel();
    } else {
        openSidePanel(tabId);
    }
}

/**
 * Returns whether the side panel is currently open.
 * @returns {boolean}
 */
export function isSidePanelOpen() {
    return isOpen;
}

/**
 * Switches to a tab without opening/closing the panel.
 * @param {string} tabId
 */
export function switchTab(tabId) {
    if (tabs.has(tabId)) activateTab(tabId);
}

// ===== Internal =====

/** Creates the panel DOM if not already present. */
function ensurePanel() {
    if (panelEl) return;

    panelEl = document.createElement('div');
    panelEl.id = 'nihongo-side-panel';
    panelEl.className = 'nihongo-side-panel';

    // Header: tabs + close
    const header = document.createElement('div');
    header.className = 'nihongo-sp-header';

    const tabBar = document.createElement('div');
    tabBar.className = 'nihongo-sp-tabs';

    // Build tab buttons
    for (const [id, def] of tabs) {
        const btn = document.createElement('button');
        btn.className = 'nihongo-sp-tab';
        btn.dataset.tab = id;
        btn.title = def.label;
        btn.innerHTML = `<i class="fa-solid ${def.icon}"></i><span>${def.label}</span>`;
        btn.addEventListener('click', () => activateTab(id));
        def._tabBtn = btn;
        tabBar.appendChild(btn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'nihongo-sp-close';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeBtn.addEventListener('click', closeSidePanel);

    header.appendChild(tabBar);
    header.appendChild(closeBtn);

    // Content area
    const content = document.createElement('div');
    content.className = 'nihongo-sp-content';

    panelEl.appendChild(header);
    panelEl.appendChild(content);
    document.body.appendChild(panelEl);

    // Escape to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) {
            // Only close if focus is inside the panel or nothing specific is focused
            if (panelEl.contains(document.activeElement) || document.activeElement === document.body) {
                closeSidePanel();
                e.preventDefault();
                e.stopPropagation();
            }
        }
    });

    console.debug(`[${EXTENSION_NAME}] Side panel created with ${tabs.size} tab(s)`);
}

/** Activates a tab, building its view if needed. */
function activateTab(tabId) {
    const def = tabs.get(tabId);
    if (!def) return;

    // Deactivate current
    if (activeTab && activeTab !== tabId) {
        const prevDef = tabs.get(activeTab);
        if (prevDef) {
            if (prevDef._tabBtn) prevDef._tabBtn.classList.remove('active');
            if (prevDef._view) prevDef._view.classList.remove('active');
            if (prevDef.onDeactivate) prevDef.onDeactivate();
        }
    }

    // Build view lazily
    if (!def._view) {
        def._view = def.build();
        def._view.classList.add('nihongo-sp-view');
        def._view.dataset.tab = tabId;
        const content = panelEl.querySelector('.nihongo-sp-content');
        content.appendChild(def._view);
    }

    // Activate
    def._tabBtn?.classList.add('active');
    def._view.classList.add('active');
    activeTab = tabId;

    if (def.onActivate) def.onActivate();
}

/** Saves the cursor position in the chat input. */
function saveCursorPosition() {
    const textarea = document.getElementById('send_textarea');
    if (textarea && textarea === document.activeElement) {
        savedSelectionStart = textarea.selectionStart;
        savedSelectionEnd = textarea.selectionEnd;
    }
}

/** Restores the cursor position in the chat input. */
function restoreCursorPosition() {
    const textarea = document.getElementById('send_textarea');
    if (textarea && savedSelectionStart !== null) {
        textarea.focus();
        textarea.setSelectionRange(savedSelectionStart, savedSelectionEnd);
        savedSelectionStart = null;
        savedSelectionEnd = null;
    }
}

/**
 * Registers the global Ctrl+Shift+F shortcut to toggle the search panel.
 * Call once during initialization.
 */
export function registerSearchShortcut() {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'F') {
            e.preventDefault();
            toggleSidePanel('search');
        }
    });
}

/**
 * Inserts text into the chat input at the saved cursor position.
 * If no position was saved, appends to end.
 * @param {string} text Text to insert
 */
export function insertIntoChatInput(text) {
    const textarea = document.getElementById('send_textarea');
    if (!textarea) return;

    const start = savedSelectionStart ?? textarea.value.length;
    const end = savedSelectionEnd ?? start;

    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);

    // Update cursor position after insertion
    const newPos = start + text.length;
    savedSelectionStart = newPos;
    savedSelectionEnd = newPos;

    // Trigger input event so ST processes the change
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
