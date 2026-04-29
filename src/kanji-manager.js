import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { EXTENSION_KEY, EXTENSION_NAME } from '../index.js';
import { loadKanjiData, queryKanji, getKanji, getAllKanji, isKanjiDataLoaded } from './kanji-data.js';
import { nihongoSettings } from './settings.js';
import { attachKanjiTooltip, destroyTooltip } from './kanji-tooltip.js';

const PAGE_SIZE = 200;

/** @type {Map<string, string>} kanji → ISO date string */
let knownKanji = new Map();

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
let lastDetailChar = null;

/**
 * Loads known kanji map from extension settings.
 * Supports both legacy array format and new object-with-dates format.
 */
function loadKnownKanji() {
    const settings = extension_settings[EXTENSION_KEY];
    if (!settings) return;
    const raw = settings.knownKanji;
    if (Array.isArray(raw)) {
        // Legacy: plain array of characters — migrate to map with null dates
        knownKanji = new Map(raw.map(k => [k, null]));
    } else if (raw && typeof raw === 'object') {
        knownKanji = new Map(Object.entries(raw));
    }
}

/**
 * Saves known kanji map to extension settings.
 */
function saveKnownKanji() {
    const settings = extension_settings[EXTENSION_KEY];
    if (settings) {
        settings.knownKanji = Object.fromEntries(knownKanji);
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
        knownKanji.set(char, new Date().toISOString());
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
 * Returns the map of known kanji (kanji → date string).
 * @returns {Map<string, string>}
 */
export function getKnownKanji() {
    return knownKanji;
}

/**
 * Returns the date a kanji was marked as known, or null.
 * @param {string} char
 * @returns {string|null}
 */
export function getKnownDate(char) {
    return knownKanji.get(char) || null;
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

        tile.tabIndex = 0;
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
    lastDetailChar = char;

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

    // Jisho link
    const jishoLink = detail.querySelector('#nihongo_km_detail_jisho');
    if (jishoLink) {
        jishoLink.href = `https://jisho.org/search/${encodeURIComponent(entry.k)}%20%23kanji`;
    }

    // Known since date
    const knownDateRow = detail.querySelector('#nihongo_km_detail_known_since_row');
    const knownDateEl = detail.querySelector('#nihongo_km_detail_known_since');
    if (knownDateRow && knownDateEl) {
        const date = getKnownDate(entry.k);
        if (date) {
            knownDateRow.style.display = '';
            knownDateEl.textContent = formatKnownDate(date);
        } else {
            knownDateRow.style.display = 'none';
        }
    }

    // Toggle known button state
    updateToggleButton(detail, entry.k);

    // Focus back button
    const backButton = detail.querySelector('#nihongo_km_detail_back');
    if (backButton) {
        backButton.focus();
    }
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

    // Focus the tile we came from
    if (lastDetailChar && grid) {
        const tile = grid.querySelector(`.nihongo-km-tile[data-kanji="${lastDetailChar}"]`);
        if (tile) tile.focus();
    }
}

/**
 * Formats an ISO date string to a human-readable "Known since" string.
 * @param {string} isoDate
 * @returns {string}
 */
function formatKnownDate(isoDate) {
    try {
        const d = new Date(isoDate);
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return '—';
    }
}

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
        onClosing: () => {
            if (detailOpen) {
                const cont = activePopup?.dlg?.querySelector('#nihongo_kanji_manager');
                if (cont) hideDetail(cont);
                return false; // Prevent popup close
            }
            return true; // Allow popup close
        },
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

        // Kanji tile click / Enter → show detail, Space → toggle known
        grid.addEventListener('click', (e) => {
            const tile = e.target.closest('.nihongo-km-tile');
            if (tile && tile.dataset.kanji) {
                showDetail(container, tile.dataset.kanji);
            }
        });
        grid.addEventListener('keydown', (e) => {
            const tile = e.target.closest('.nihongo-km-tile');
            if (!tile || !tile.dataset.kanji) return;

            if (e.key === 'Enter') {
                e.preventDefault();
                showDetail(container, tile.dataset.kanji);
            } else if (e.key === ' ') {
                e.preventDefault();
                const char = tile.dataset.kanji;
                toggleKnown(char);
                tile.classList.toggle('nihongo-km-tile-known', knownKanji.has(char));
                const knownCountEl = container.querySelector('#nihongo_km_known_count');
                if (knownCountEl) knownCountEl.textContent = `${knownKanji.size} known`;
            } else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
                e.preventDefault();
                const tiles = [...grid.querySelectorAll('.nihongo-km-tile')];
                const idx = tiles.indexOf(tile);
                if (idx === -1) return;

                // Calculate columns from grid layout
                const gridStyle = getComputedStyle(grid);
                const cols = gridStyle.gridTemplateColumns.split(' ').length || 1;

                let nextIdx = idx;
                switch (e.key) {
                    case 'ArrowRight': nextIdx = idx + 1; break;
                    case 'ArrowLeft': nextIdx = idx - 1; break;
                    case 'ArrowDown': nextIdx = idx + cols; break;
                    case 'ArrowUp': nextIdx = idx - cols; break;
                }

                if (nextIdx >= 0 && nextIdx < tiles.length) {
                    tiles[nextIdx].focus();
                    tiles[nextIdx].scrollIntoView({ block: 'nearest' });
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

            // Update known since row
            const knownDateRow = container.querySelector('#nihongo_km_detail_known_since_row');
            const knownDateEl = container.querySelector('#nihongo_km_detail_known_since');
            if (knownDateRow && knownDateEl) {
                const date = getKnownDate(char);
                if (date) {
                    knownDateRow.style.display = '';
                    knownDateEl.textContent = formatKnownDate(date);
                } else {
                    knownDateRow.style.display = 'none';
                }
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

        // Backspace in detail view → back to grid (Escape is handled by onClosing)
        activePopup?.dlg?.addEventListener('keydown', (e) => {
            if (!detailOpen) return;
            if (e.key === 'Backspace') {
                const tag = e.target?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                e.preventDefault();
                hideDetail(container);
            }
        });

        // Infinite scroll for the grid
        // The actual scrollable element is .popup-content (overflow-y: auto via vertical_scrolling_dialogue_popup)
        const scrollContainer = activePopup?.dlg?.querySelector('.popup-content');
        if (scrollContainer) {
            scrollContainer.addEventListener('scroll', () => {
                if (grid.style.display === 'none') return;
                const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
                if (scrollTop + clientHeight >= scrollHeight - 200) {
                    const maxPages = Math.ceil(currentResults.length / PAGE_SIZE);
                    if (currentPage + 1 < maxPages) {
                        currentPage++;
                        renderGrid(grid);
                    }
                }
            });
        }

        // Attach kanji tooltip to the grid, bounded by and appended to the popup dialog
        const popupDialog = activePopup?.dlg;
        if (popupDialog) {
            attachKanjiTooltip(grid, { boundingEl: popupDialog, appendTo: popupDialog });
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
