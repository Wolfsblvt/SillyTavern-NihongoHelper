import { renderExtensionTemplateAsync } from '../../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { EXTENSION_NAME } from '../index.js';
import { loadKanjiData, queryKanji, getKanji, getAllKanji, isKanjiDataLoaded } from './kanji-data.js';
import { nihongoSettings } from './settings.js';
import { attachKanjiTooltip, destroyTooltip } from './kanji-tooltip.js';
import {
    loadKanjiState,
    getState,
    getStateEntry,
    setState,
    isKnown,
    getKnownKanji,
    getLearningKanji,
} from './kanji-state.js';

const PAGE_SIZE = 200;

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

// Kanji state (known / learning / unknown) lives in src/kanji-state.js.
// This module imports state APIs and renders the Kanji Manager UI on top of them.

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
        const tileState = getState(entry.k);
        if (tileState === 'known') tile.classList.add('nihongo-km-tile-known');
        else if (tileState === 'learning') tile.classList.add('nihongo-km-tile-learning');
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
    updateStatusCounts(grid.closest('#nihongo_kanji_manager'));
}

/**
 * Updates the known/learning count chips in the manager header.
 * @param {Element|null} container The #nihongo_kanji_manager element
 */
function updateStatusCounts(container) {
    if (!container) return;
    const knownCountEl = container.querySelector('#nihongo_km_known_count');
    if (knownCountEl) knownCountEl.textContent = `${getKnownKanji().size} known`;
    const learningCountEl = container.querySelector('#nihongo_km_learning_count');
    if (learningCountEl) learningCountEl.textContent = `${getLearningKanji().size} learning`;
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
        getState,
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
        const detailState = getState(entry.k);
        if (detailState === 'known') detailKanji.classList.add('nihongo-km-detail-kanji-known');
        else if (detailState === 'learning') detailKanji.classList.add('nihongo-km-detail-kanji-learning');
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

    // Timestamps
    updateDetailTimestamps(detail, entry.k);

    // State selector
    updateStateSelector(detail, entry.k);

    // Focus back button
    const backButton = detail.querySelector('#nihongo_km_detail_back');
    if (backButton instanceof HTMLElement) {
        backButton.focus();
    }
}

/**
 * Refreshes the "Learning since" / "Known since" rows in the detail view.
 * @param {Element} detail
 * @param {string} char
 */
function updateDetailTimestamps(detail, char) {
    const stateEntry = getStateEntry(char);
    const knownRow = detail.querySelector('#nihongo_km_detail_known_since_row');
    const knownVal = detail.querySelector('#nihongo_km_detail_known_since');
    if (knownRow instanceof HTMLElement && knownVal) {
        if (stateEntry?.knownSince) {
            knownRow.style.display = '';
            knownVal.textContent = formatStateDate(stateEntry.knownSince);
        } else {
            knownRow.style.display = 'none';
        }
    }
    const learningRow = detail.querySelector('#nihongo_km_detail_learning_since_row');
    const learningVal = detail.querySelector('#nihongo_km_detail_learning_since');
    if (learningRow instanceof HTMLElement && learningVal) {
        if (stateEntry?.learningSince) {
            learningRow.style.display = '';
            learningVal.textContent = formatStateDate(stateEntry.learningSince);
        } else {
            learningRow.style.display = 'none';
        }
    }
}

/**
 * Updates the active state on the segmented Unknown / Learning / Known selector.
 * @param {Element} detail
 * @param {string} char
 */
function updateStateSelector(detail, char) {
    const selector = detail.querySelector('#nihongo_km_detail_state_selector');
    if (!selector) return;
    const state = getState(char);
    selector.querySelectorAll('button[data-state]').forEach(btn => {
        if (btn instanceof HTMLElement) {
            const isActive = btn.dataset.state === state;
            btn.classList.toggle('nihongo-state-active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        }
    });
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
 * Formats an ISO date string for display in the detail timestamps.
 * @param {string} isoDate
 * @returns {string}
 */
function formatStateDate(isoDate) {
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
    loadKanjiState();
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
        const stateSelector = container.querySelector('#nihongo_km_detail_state_selector');

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

        // Kanji tile click / Enter → show detail, Space → cycle state, Shift+Space → mark known
        grid.addEventListener('click', (e) => {
            const tile = e.target instanceof Element ? e.target.closest('.nihongo-km-tile') : null;
            if (tile instanceof HTMLElement && tile.dataset.kanji) {
                showDetail(container, tile.dataset.kanji);
            }
        });
        grid.addEventListener('keydown', (e) => {
            const tile = e.target instanceof Element ? e.target.closest('.nihongo-km-tile') : null;
            if (!(tile instanceof HTMLElement) || !tile.dataset.kanji) return;

            if (e.key === 'Enter') {
                e.preventDefault();
                showDetail(container, tile.dataset.kanji);
            } else if (e.key === ' ') {
                e.preventDefault();
                const char = tile.dataset.kanji;
                // Shift+Space jumps straight to/from Known. Plain Space cycles.
                const next = e.shiftKey
                    ? (isKnown(char) ? 'unknown' : 'known')
                    : ({ unknown: 'learning', learning: 'known', known: 'unknown' }[getState(char)]);
                applyStateChange(container, grid, char, /** @type {'unknown'|'learning'|'known'} */ (next));
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
                    if (tiles[nextIdx] instanceof HTMLElement) {
                        /** @type {HTMLElement} */ (tiles[nextIdx]).focus();
                    }
                    tiles[nextIdx].scrollIntoView({ block: 'nearest' });
                }
            }
        });

        // Back button
        backBtn?.addEventListener('click', () => {
            hideDetail(container);
        });

        // Tri-state selector in detail view (Unknown / Learning / Known)
        const detailKanjiEl = container.querySelector('#nihongo_km_detail_kanji');

        stateSelector?.addEventListener('click', (e) => {
            const target = e.target instanceof Element ? e.target.closest('button[data-state]') : null;
            if (!(target instanceof HTMLElement)) return;
            const char = detailKanjiEl?.textContent;
            const next = /** @type {'unknown'|'learning'|'known'} */ (target.dataset.state);
            if (!char || !next) return;
            applyStateChange(container, grid, char, next);
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
 * Applies a state change for `char` and refreshes the affected UI surfaces:
 * grid tile classes, status counts, detail-view kanji styling, timestamps,
 * and the segmented selector. Also notifies the rest of the app so
 * furigana / DOM kanji spans update.
 * @param {Element} container The #nihongo_kanji_manager element
 * @param {HTMLElement} grid The kanji grid element
 * @param {string} char
 * @param {'unknown'|'learning'|'known'} newState
 */
function applyStateChange(container, grid, char, newState) {
    setState(char, newState);

    // Update tile in grid
    const tile = grid.querySelector(`.nihongo-km-tile[data-kanji="${char}"]`);
    if (tile) {
        const s = getState(char);
        tile.classList.toggle('nihongo-km-tile-known', s === 'known');
        tile.classList.toggle('nihongo-km-tile-learning', s === 'learning');
    }

    // Update detail view if showing this kanji
    const detail = container.querySelector('#nihongo_km_detail');
    const detailKanjiEl = container.querySelector('#nihongo_km_detail_kanji');
    if (detail && detailKanjiEl?.textContent === char) {
        const s = getState(char);
        detailKanjiEl.classList.toggle('nihongo-km-detail-kanji-known', s === 'known');
        detailKanjiEl.classList.toggle('nihongo-km-detail-kanji-learning', s === 'learning');
        updateDetailTimestamps(detail, char);
        updateStateSelector(detail, char);
    }

    updateStatusCounts(container);
    notifyStateChanged(char);
}

/**
 * Notifies other parts of the extension that the state of `char` changed.
 * Updates kanji span classes already in the DOM, then re-processes affected
 * messages so furigana visibility (`hideKnownFurigana`) updates.
 * Imported lazily to avoid a hard cycle (kanji-manager ↔ furigana / kanji-tooltip).
 * @param {string} char
 */
async function notifyStateChanged(char) {
    document.querySelectorAll(`.nihongo-kanji[data-kanji="${char}"]`).forEach(el => {
        el.classList.toggle('nihongo-kanji-known', isKnown(char));
        el.classList.toggle('nihongo-kanji-learning', getState(char) === 'learning');
    });
    try {
        const { reprocessMessagesWithKanji } = await import('./furigana.js');
        reprocessMessagesWithKanji(char);
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] notifyStateChanged: failed to reprocess`, err);
    }
}

/**
 * Initializes the kanji manager module.
 * Registers the button listener and preloads data.
 */
export function initKanjiManager() {
    loadKanjiState();
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
