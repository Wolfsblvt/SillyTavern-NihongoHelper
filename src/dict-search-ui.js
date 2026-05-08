import { registerTab, insertIntoChatInput, openSidePanel } from './side-panel.js';
import { searchDictionary, buildSearchIndex } from './dict-search.js';
import { getJMdictTags } from './jmdict.js';
import { getDerivedLevel, getConfidence } from './tracking.js';
import { getFrequencyTier, getCompositeFrequency, isFrequencyAvailable } from './frequency.js';
import { EXTENSION_NAME } from '../index.js';

/**
 * Dictionary search UI — the "Search" tab in the side panel.
 *
 * Provides a search bar with instant results as Jisho-style cards.
 * Each card shows: word, reading, brief glosses, tags (common, freq, tracking).
 * Cards are clickable to insert, with copy and tooltip-hover support.
 */

// ===== State =====

/** @type {HTMLInputElement|null} */
let searchInput = null;
/** @type {HTMLElement|null} */
let resultsContainer = null;
/** @type {HTMLElement|null} */
let statusBar = null;
let debounceTimer = null;

// ===== Init =====

/**
 * Registers the search tab with the side panel.
 * Call during extension init.
 */
export function initDictSearchUI() {
    registerTab('search', {
        icon: 'fa-magnifying-glass',
        label: 'Search',
        build: buildSearchView,
        onActivate: () => {
            // Focus the search input when tab activates
            if (searchInput) {
                requestAnimationFrame(() => searchInput.focus());
            }
        },
    });
}

/**
 * Opens the side panel to the search tab, optionally pre-filling a query.
 * @param {string} [query] Pre-fill search query
 */
export function openDictSearch(query) {
    openSidePanel('search');
    if (query && searchInput) {
        searchInput.value = query;
        updateClearButton();
        performSearch(query);
    }
}

// ===== Build View =====

/** Builds the search tab's DOM. Called once (lazy). */
function buildSearchView() {
    const view = document.createElement('div');

    // Search bar
    const bar = document.createElement('div');
    bar.className = 'nihongo-search-bar';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'nihongo-search-input-wrap';

    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'nihongo-search-input';
    searchInput.placeholder = 'Search dictionary...';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'nihongo-search-clear';
    clearBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    clearBtn.title = 'Clear';
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        updateClearButton();
        performSearch('');
        searchInput.focus();
    });

    inputWrap.appendChild(searchInput);
    inputWrap.appendChild(clearBtn);
    bar.appendChild(inputWrap);

    // Input event: debounced search
    searchInput.addEventListener('input', () => {
        updateClearButton();
        const query = searchInput.value;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => performSearch(query), 200);
    });

    // Enter key: immediate search
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (debounceTimer) clearTimeout(debounceTimer);
            performSearch(searchInput.value);
        }
    });

    // Results
    resultsContainer = document.createElement('div');
    resultsContainer.className = 'nihongo-search-results';
    showEmptyState();

    // Status bar
    statusBar = document.createElement('div');
    statusBar.className = 'nihongo-search-status';
    statusBar.textContent = '';

    view.appendChild(bar);
    view.appendChild(resultsContainer);
    view.appendChild(statusBar);

    return view;
}

// ===== Search Logic =====

function performSearch(query) {
    if (!resultsContainer) return;

    const trimmed = query.trim();
    if (trimmed.length === 0) {
        showEmptyState();
        statusBar.textContent = '';
        return;
    }

    // Ensure index is built
    if (!buildSearchIndex()) {
        resultsContainer.innerHTML = '';
        showMessage('Dictionary not loaded yet. Please wait...', 'fa-spinner fa-spin');
        return;
    }

    const results = searchDictionary(trimmed, { limit: 30 });

    if (results.length === 0) {
        resultsContainer.innerHTML = '';
        showMessage('No results found', 'fa-face-meh');
        statusBar.textContent = '';
        return;
    }

    renderResults(results);
    statusBar.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
}

// ===== Rendering =====

function showEmptyState() {
    if (!resultsContainer) return;
    resultsContainer.innerHTML = '';
    showMessage('Type to search the dictionary', 'fa-book-open');
}

function showMessage(text, icon) {
    const el = document.createElement('div');
    el.className = 'nihongo-search-empty';
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${text}</span>`;
    resultsContainer.appendChild(el);
}

function renderResults(results) {
    resultsContainer.innerHTML = '';
    const tags = getJMdictTags();

    for (const result of results) {
        const card = buildResultCard(result, tags);
        resultsContainer.appendChild(card);
    }
}

/**
 * @param {import('./dict-search.js').SearchResult} result
 * @param {Object} tags
 */
function buildResultCard(result, tags) {
    const card = document.createElement('div');
    card.className = 'nihongo-search-card';

    // Top row: word + reading + tags
    const top = document.createElement('div');
    top.className = 'nihongo-search-card-top';

    const wordEl = document.createElement('span');
    wordEl.className = 'nihongo-search-word';
    wordEl.textContent = result.word;
    top.appendChild(wordEl);

    // Only show reading if different from word (kanji entries)
    if (result.reading && result.reading !== result.word) {
        const readingEl = document.createElement('span');
        readingEl.className = 'nihongo-search-reading';
        readingEl.textContent = result.reading;
        top.appendChild(readingEl);
    }

    // Tags
    const tagsEl = document.createElement('div');
    tagsEl.className = 'nihongo-search-tags';

    if (result.common) {
        const tag = createTag('common', 'nihongo-search-tag-common');
        tagsEl.appendChild(tag);
    }

    // Frequency tier
    if (isFrequencyAvailable()) {
        const tier = getFrequencyTier(result.word);
        if (tier) {
            const freq = getCompositeFrequency(result.word);
            const tag = createTag(tier === 'top1k' ? 'top 1K' : tier === 'top5k' ? 'top 5K' : tier === 'top15k' ? 'top 15K' : tier, '');
            if (freq) tag.title = `Frequency rank: ~${freq}`;
            tagsEl.appendChild(tag);
        }
    }

    // Tracking level
    const level = getDerivedLevel(result.word);
    if (level !== 'unknown') {
        const conf = getConfidence(result.word);
        const tag = createTag(level, 'nihongo-search-tag-tracked');
        tag.title = `Confidence: ${(conf * 100).toFixed(0)}%`;
        tagsEl.appendChild(tag);
    }

    top.appendChild(tagsEl);
    card.appendChild(top);

    // Glosses — first 2 senses, brief
    const glosses = document.createElement('div');
    glosses.className = 'nihongo-search-glosses';
    const glossText = result.senses
        .slice(0, 3)
        .map((s, i) => {
            const pos = s.p ? s.p.map(p => tags?.[p] || p).join(', ') : '';
            const meanings = s.g.join('; ');
            return `${i + 1}. ${pos ? `[${pos}] ` : ''}${meanings}`;
        })
        .join(' ');
    glosses.textContent = glossText;
    card.appendChild(glosses);

    // Action buttons (visible on hover)
    const actions = document.createElement('div');
    actions.className = 'nihongo-search-card-actions';

    const insertBtn = createActionBtn('Insert', 'fa-arrow-turn-down', () => {
        insertIntoChatInput(result.word);
    });

    const copyBtn = createActionBtn('Copy', 'fa-copy', () => {
        navigator.clipboard.writeText(result.word).catch(() => {});
        copyBtn.querySelector('i').className = 'fa-solid fa-check';
        setTimeout(() => {
            copyBtn.querySelector('i').className = 'fa-solid fa-copy';
        }, 1200);
    });

    actions.appendChild(insertBtn);
    actions.appendChild(copyBtn);
    card.appendChild(actions);

    // Click card → insert word
    card.addEventListener('click', (e) => {
        // Don't insert if clicking an action button
        if (e.target.closest('.nihongo-search-action-btn')) return;
        insertIntoChatInput(result.word);
    });

    return card;
}

function createTag(text, extraClass) {
    const el = document.createElement('span');
    el.className = `nihongo-search-tag ${extraClass}`.trim();
    el.textContent = text;
    return el;
}

function createActionBtn(title, icon, handler) {
    const btn = document.createElement('button');
    btn.className = 'nihongo-search-action-btn';
    btn.title = title;
    btn.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler();
    });
    return btn;
}

function updateClearButton() {
    if (!searchInput) return;
    const clearBtn = searchInput.parentElement?.querySelector('.nihongo-search-clear');
    if (clearBtn) {
        clearBtn.classList.toggle('visible', searchInput.value.length > 0);
    }
}
