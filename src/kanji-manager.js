import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { EXTENSION_KEY, EXTENSION_NAME } from '../index.js';
import { loadKanjiData, queryKanji, getKanji, getAllKanji, isKanjiDataLoaded } from './kanji-data.js';
import { nihongoSettings } from './settings.js';
import { attachKanjiTooltip, destroyTooltip } from './kanji-tooltip.js';

const PAGE_SIZE = 200;

/** @type {Set<string>} */
let knownKanji = new Set();

/** @type {Popup|null} */
let activePopup = null;

/** Current query state */
let currentFilter = 'all';
let currentSort = 'freq_asc';
let currentSearch = '';
let currentPage = 0;
let currentResults = [];
let totalKanjiCount = 0;
let detailOpen = false;

/**
 * Loads known kanji set from extension settings.
 */
function loadKnownKanji() {
    const settings = extension_settings[EXTENSION_KEY];
    if (settings && Array.isArray(settings.knownKanji)) {
        knownKanji = new Set(settings.knownKanji);
    }
}

/**
 * Saves known kanji set to extension settings.
 */
function saveKnownKanji() {
    const settings = extension_settings[EXTENSION_KEY];
    if (settings) {
        settings.knownKanji = [...knownKanji];
        saveSettingsDebounced();
    }
}

/**
 * Toggles a kanji's known status.
 * @param {string} char
 * @returns {boolean} New known state
 */
export function toggleKnown(char) {
    if (knownKanji.has(char)) {
        knownKanji.delete(char);
    } else {
        knownKanji.add(char);
    }
    saveKnownKanji();
    return knownKanji.has(char);
}

/**
 * Checks if a kanji is marked as known.
 * @param {string} char
 * @returns {boolean}
 */
export function isKnown(char) {
    return knownKanji.has(char);
}

/**
 * Returns the set of known kanji.
 * @returns {Set<string>}
 */
export function getKnownKanji() {
    return knownKanji;
}

/**
 * Gets the badge text to show on a kanji tile based on current sort.
 * @param {import('./kanji-data.js').KanjiEntry} entry
 * @returns {string}
 */
function getBadgeText(entry) {
    switch (currentSort) {
        case 'freq_asc':
        case 'freq_desc':
            return entry.f ? `#${entry.f}` : '';
        case 'jlpt_easy':
        case 'jlpt_hard':
            return entry.jlpt ? `N${entry.jlpt}` : '';
        case 'grade_asc':
            return entry.g ? (entry.g <= 6 ? `G${entry.g}` : 'JH') : '';
        case 'strokes_asc':
        case 'strokes_desc':
            return entry.s ? `${entry.s}画` : '';
        default:
            return '';
    }
}

/**
 * Renders a page of kanji tiles into the grid.
 * @param {HTMLElement} grid
 */
function renderGrid(grid) {
    const start = currentPage * PAGE_SIZE;
    const pageEntries = currentResults.slice(start, start + PAGE_SIZE);

    if (currentPage === 0) {
        grid.innerHTML = '';
    }

    for (const entry of pageEntries) {
        const tile = document.createElement('div');
        tile.className = 'nihongo-km-tile interactable';
        tile.tabIndex = 0;
        if (knownKanji.has(entry.k)) {
            tile.classList.add('nihongo-km-tile-known');
        }
        tile.dataset.kanji = entry.k;

        // Kanji character
        const kanjiSpan = document.createElement('span');
        kanjiSpan.className = 'nihongo-km-tile-char';
        kanjiSpan.textContent = entry.k;
        tile.appendChild(kanjiSpan);

        // Badge (context-aware based on sort)
        const badge = getBadgeText(entry);
        if (badge) {
            const badgeEl = document.createElement('span');
            badgeEl.className = 'nihongo-km-tile-badge';
            badgeEl.textContent = badge;
            tile.appendChild(badgeEl);
        }

        tile.title = entry.m.slice(0, 3).join(', ');
        grid.appendChild(tile);
    }

    // Update count display — "X of Y kanji" format
    const countEl = grid.closest('#nihongo_kanji_manager')?.querySelector('#nihongo_km_count');
    if (countEl) {
        if (currentSearch || currentFilter !== 'all') {
            countEl.textContent = `${currentResults.length} of ${totalKanjiCount} kanji`;
        } else {
            countEl.textContent = `${currentResults.length} kanji`;
        }
    }
    const knownCountEl = grid.closest('#nihongo_kanji_manager')?.querySelector('#nihongo_km_known_count');
    if (knownCountEl) {
        knownCountEl.textContent = `${knownKanji.size} known`;
    }
}

/**
 * Runs the current query and refreshes the grid.
 * @param {HTMLElement} grid
 */
function refreshGrid(grid) {
    currentResults = queryKanji({
        filter: currentFilter,
        sort: currentSort,
        search: currentSearch,
        knownKanji,
    });
    currentPage = 0;
    renderGrid(grid);
}

/**
 * Shows the detail view for a kanji.
 * @param {HTMLElement} container The #nihongo_kanji_manager element
 * @param {string} char The kanji character
 */
function showDetail(container, char) {
    const entry = getKanji(char);
    if (!entry) return;

    const grid = container.querySelector('#nihongo_km_grid');
    const detail = container.querySelector('#nihongo_km_detail');
    const header = container.querySelector('.nihongo-km-header');
    if (!grid || !detail || !header) return;

    grid.style.display = 'none';
    header.style.display = 'none';
    detail.style.display = '';
    detailOpen = true;

    // Populate
    const detailKanji = detail.querySelector('#nihongo_km_detail_kanji');
    if (detailKanji) {
        detailKanji.textContent = entry.k;
        detailKanji.className = 'nihongo-km-detail-kanji';
        if (knownKanji.has(entry.k)) {
            detailKanji.classList.add('nihongo-km-detail-kanji-known');
        }
    }

    const setField = (id, value) => {
        const el = detail.querySelector(`#${id}`);
        if (el) el.textContent = value;
    };

    setField('nihongo_km_detail_meanings', entry.m.join(', ') || '—');
    setField('nihongo_km_detail_onyomi', entry.on.join('、 ') || '—');
    setField('nihongo_km_detail_kunyomi', entry.kun.join('、 ') || '—');
    setField('nihongo_km_detail_jlpt', entry.jlpt ? `N${entry.jlpt}` : '—');
    setField('nihongo_km_detail_grade', formatGrade(entry.g));
    setField('nihongo_km_detail_strokes', entry.s ? String(entry.s) : '—');
    setField('nihongo_km_detail_freq', entry.f ? `#${entry.f}` : '—');

    // Toggle known button state
    updateToggleButton(detail, entry.k);
}

/**
 * Updates the toggle known button text/icon for the current kanji.
 * @param {Element} detail
 * @param {string} char
 */
function updateToggleButton(detail, char) {
    const btn = detail.querySelector('#nihongo_km_detail_toggle_known');
    if (!btn) return;
    const icon = btn.querySelector('i');
    const span = btn.querySelector('span');
    const known = knownKanji.has(char);
    if (icon) icon.className = known ? 'fa-solid fa-star' : 'fa-regular fa-star';
    if (span) span.textContent = known ? 'Known' : 'Mark Known';
}

/**
 * Hides the detail view and shows the grid.
 * @param {HTMLElement} container
 */
function hideDetail(container) {
    const grid = container.querySelector('#nihongo_km_grid');
    const detail = container.querySelector('#nihongo_km_detail');
    const header = container.querySelector('.nihongo-km-header');
    if (grid) grid.style.display = '';
    if (detail) detail.style.display = 'none';
    if (header) header.style.display = '';
    detailOpen = false;
}

/**
 * Formats a grade number to a readable string.
 * @param {number|null} grade
 * @returns {string}
 */
function formatGrade(grade) {
    if (!grade) return '—';
    if (grade >= 1 && grade <= 6) return `Grade ${grade}`;
    if (grade === 8) return 'Junior High';
    if (grade === 9 || grade === 10) return 'Jinmeiyō';
    return String(grade);
}

/**
 * Opens the Kanji Manager popup.
 */
export async function openKanjiManager() {
    if (!isKanjiDataLoaded()) {
        await loadKanjiData();
    }
    loadKnownKanji();
    totalKanjiCount = getAllKanji().length;

    // Restore saved sort/filter
    currentSort = nihongoSettings.kmSort;
    currentFilter = nihongoSettings.kmFilter;
    currentSearch = '';
    detailOpen = false;

    const html = await renderExtensionTemplateAsync(
        `third-party/${EXTENSION_NAME}`,
        'templates/kanji-manager',
        {},
        true,
        true,
    );

    activePopup = new Popup(html, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wider: true,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
        okButton: false,
        cancelButton: false,
    });

    const popupResult = activePopup.show();

    // Clean up tooltip when popup closes
    popupResult.finally(() => {
        destroyTooltip();
    });

    // Wait for DOM
    requestAnimationFrame(() => {
        const container = activePopup?.dlg?.querySelector('#nihongo_kanji_manager');
        if (!container) return;

        const grid = container.querySelector('#nihongo_km_grid');
        const searchInput = container.querySelector('#nihongo_km_search');
        const searchClearBtn = container.querySelector('#nihongo_km_search_clear');
        const filterSelect = container.querySelector('#nihongo_km_filter');
        const sortSelect = container.querySelector('#nihongo_km_sort');
        const backBtn = container.querySelector('#nihongo_km_detail_back');
        const toggleKnownBtn = container.querySelector('#nihongo_km_detail_toggle_known');

        if (!grid) return;

        // Restore saved values to UI
        if (filterSelect) filterSelect.value = currentFilter;
        if (sortSelect) sortSelect.value = currentSort;

        // Initial render
        refreshGrid(grid);

        // Search with debounce + clear button visibility
        let searchTimer = null;
        searchInput?.addEventListener('input', (e) => {
            if (searchTimer) clearTimeout(searchTimer);
            const val = e.target.value;
            if (searchClearBtn) searchClearBtn.style.display = val ? '' : 'none';
            searchTimer = setTimeout(() => {
                currentSearch = val;
                refreshGrid(grid);
            }, 300);
        });

        // Search clear button
        searchClearBtn?.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
            if (searchClearBtn) searchClearBtn.style.display = 'none';
            currentSearch = '';
            refreshGrid(grid);
        });

        // Filter change (persist)
        filterSelect?.addEventListener('change', (e) => {
            currentFilter = e.target.value;
            nihongoSettings.kmFilter = currentFilter;
            refreshGrid(grid);
        });

        // Sort change (persist)
        sortSelect?.addEventListener('change', (e) => {
            currentSort = e.target.value;
            nihongoSettings.kmSort = currentSort;
            refreshGrid(grid);
        });

        // Kanji tile click / Enter → show detail
        grid.addEventListener('click', (e) => {
            const tile = e.target.closest('.nihongo-km-tile');
            if (tile && tile.dataset.kanji) {
                showDetail(container, tile.dataset.kanji);
            }
        });
        grid.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                const tile = e.target.closest('.nihongo-km-tile');
                if (tile && tile.dataset.kanji) {
                    e.preventDefault();
                    showDetail(container, tile.dataset.kanji);
                }
            }
        });

        // Back button
        backBtn?.addEventListener('click', () => {
            hideDetail(container);
        });

        // Toggle known in detail view
        const detailKanjiEl = container.querySelector('#nihongo_km_detail_kanji');

        toggleKnownBtn?.addEventListener('click', () => {
            const char = detailKanjiEl?.textContent;
            if (!char) return;
            toggleKnown(char);
            updateToggleButton(container.querySelector('#nihongo_km_detail'), char);

            // Update detail kanji styling
            if (detailKanjiEl) {
                detailKanjiEl.classList.toggle('nihongo-km-detail-kanji-known', knownKanji.has(char));
            }

            // Update the tile in the grid if visible
            const tile = grid.querySelector(`.nihongo-km-tile[data-kanji="${char}"]`);
            if (tile) {
                tile.classList.toggle('nihongo-km-tile-known', knownKanji.has(char));
            }

            // Update known count
            const knownCountEl = container.querySelector('#nihongo_km_known_count');
            if (knownCountEl) {
                knownCountEl.textContent = `${knownKanji.size} known`;
            }
        });

        // Keyboard: Escape/Backspace in detail view → back to grid (not close popup)
        activePopup?.dlg?.addEventListener('keydown', (e) => {
            if (!detailOpen) return;
            if (e.key === 'Escape' || e.key === 'Backspace') {
                // Don't close popup, just go back
                if (e.target === document.body || container.contains(e.target)) {
                    e.preventDefault();
                    e.stopPropagation();
                    hideDetail(container);
                }
            }
        }, true); // capture phase to beat popup's own handler

        // Infinite scroll for the grid
        const popupBody = activePopup?.dlg?.querySelector('.popup-body');
        if (popupBody) {
            popupBody.addEventListener('scroll', () => {
                if (grid.style.display === 'none') return;
                const { scrollTop, scrollHeight, clientHeight } = popupBody;
                if (scrollTop + clientHeight >= scrollHeight - 100) {
                    const maxPages = Math.ceil(currentResults.length / PAGE_SIZE);
                    if (currentPage + 1 < maxPages) {
                        currentPage++;
                        renderGrid(grid);
                    }
                }
            });
        }

        // Attach kanji tooltip to the grid, bounded by the popup dialog
        const popupDialog = activePopup?.dlg;
        if (popupDialog) {
            attachKanjiTooltip(grid, { boundingEl: popupDialog });
        }
    });
}

/**
 * Initializes the kanji manager module.
 * Registers the button listener and preloads data.
 */
export function initKanjiManager() {
    loadKnownKanji();
    // Preload kanji data in background
    loadKanjiData();

    // Register button listener (settings UI may already be in DOM or appear later)
    const registerButton = () => {
        const btn = document.getElementById('nihongo_helper_open_kanji_manager');
        if (btn && !btn.dataset.kmBound) {
            btn.dataset.kmBound = 'true';
            btn.addEventListener('click', () => openKanjiManager());
        }
    };

    // Try immediately and also observe for future DOM insertions
    registerButton();
    const observer = new MutationObserver(() => {
        registerButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}
