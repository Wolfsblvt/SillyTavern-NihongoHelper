import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { EXTENSION_KEY, EXTENSION_NAME } from '../index.js';
import { loadKanjiData, queryKanji, getKanji, isKanjiDataLoaded, getAllKanji } from './kanji-data.js';

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
        tile.className = 'nihongo-km-tile';
        if (knownKanji.has(entry.k)) {
            tile.classList.add('nihongo-km-tile-known');
        }
        tile.dataset.kanji = entry.k;
        tile.textContent = entry.k;
        tile.title = entry.m.slice(0, 3).join(', ');
        grid.appendChild(tile);
    }

    // Update count display
    const countEl = grid.closest('#nihongo_kanji_manager')?.querySelector('#nihongo_km_count');
    if (countEl) {
        countEl.textContent = `${currentResults.length} kanji`;
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

    const html = await renderExtensionTemplateAsync(
        `third-party/${EXTENSION_NAME}`,
        'templates/kanji-manager',
        {},
        true,
        true,
    );

    activePopup = new Popup(html, POPUP_TYPE.DISPLAY, '', {
        large: true,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
        okButton: false,
        cancelButton: false,
    });

    activePopup.show();

    // Wait for DOM
    requestAnimationFrame(() => {
        const container = activePopup?.dlg?.querySelector('#nihongo_kanji_manager');
        if (!container) return;

        const grid = container.querySelector('#nihongo_km_grid');
        const searchInput = container.querySelector('#nihongo_km_search');
        const filterSelect = container.querySelector('#nihongo_km_filter');
        const sortSelect = container.querySelector('#nihongo_km_sort');
        const backBtn = container.querySelector('#nihongo_km_detail_back');
        const toggleKnownBtn = container.querySelector('#nihongo_km_detail_toggle_known');

        if (!grid) return;

        // Initial render
        refreshGrid(grid);

        // Search with debounce
        let searchTimer = null;
        searchInput?.addEventListener('input', (e) => {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                currentSearch = e.target.value;
                refreshGrid(grid);
            }, 300);
        });

        // Filter change
        filterSelect?.addEventListener('change', (e) => {
            currentFilter = e.target.value;
            refreshGrid(grid);
        });

        // Sort change
        sortSelect?.addEventListener('change', (e) => {
            currentSort = e.target.value;
            refreshGrid(grid);
        });

        // Kanji tile click → show detail
        grid.addEventListener('click', (e) => {
            const tile = e.target.closest('.nihongo-km-tile');
            if (tile && tile.dataset.kanji) {
                showDetail(container, tile.dataset.kanji);
            }
        });

        // Back button
        backBtn?.addEventListener('click', () => {
            hideDetail(container);
        });

        // Toggle known in detail view
        let detailKanji = null;
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
