/**
 * Side Chat Action Registry.
 *
 * Tutor presets define the available actions (Explain, Translate, etc.) as
 * declarative JSON. This module turns the raw `actions` object from a preset
 * into a normalized, validated registry the rest of the extension can consume.
 *
 * Action shape (preset JSON):
 *
 *   "actions": {
 *     "explain": {
 *       "label": "Explain",
 *       "description": "Explain the highlighted word in context.",  // optional, used as button tooltip
 *       "icon": "fa-circle-question",         // optional
 *       "visibility": ["tooltip", "selection"], // optional, defaults to tooltip+selection
 *       "requiresDictionaryMatch": false,     // optional, defaults to false
 *       "system": "...",                      // template, macro-aware
 *       "user": "..."                         // template, macro-aware
 *     },
 *     "custom": {
 *       "label": "Ask",
 *       "description": "Ask a free-form follow-up question.",
 *       "visibility": ["manual"],
 *       "system": "...",
 *       "user": "..."
 *     }
 *   }
 *
 * The action ID is the object key. Invalid actions are skipped with a console
 * warning. The registry always exposes at least a `custom` action: if the
 * active preset omits it (or its `custom` is invalid), the bundled default
 * preset's `custom` is used as a fallback so free-form input keeps working.
 */

import { EXTENSION_NAME } from '../index.js';

// ===== Constants =====

/** Visibility contexts a preset action can declare. Unknown values are ignored. */
export const VISIBILITY = Object.freeze({
    /** Word tooltip (hover OR selection lookup with a dictionary match). */
    TOOLTIP: 'tooltip',
    /** Minimal selection-fallback tooltip (text selected, no dictionary match). */
    SELECTION: 'selection',
    /** Free-form / manual side-chat input (used as the "ask" action). */
    MANUAL: 'manual',
});

/** @type {Set<string>} */
const VALID_VISIBILITY = new Set(Object.values(VISIBILITY));

/** Default visibility when a preset action does not specify any. */
const DEFAULT_VISIBILITY = [VISIBILITY.TOOLTIP, VISIBILITY.SELECTION];

/** Default FontAwesome icon (no `fa-solid` prefix) for actions without one. */
const DEFAULT_ICON = 'fa-circle-question';

/** Reserved action ID used for free-form / manual follow-up. */
export const CUSTOM_ACTION_ID = 'custom';

// ===== Types =====

/**
 * @typedef {Object} ChatAction
 * @property {string} id
 * @property {string} label
 * @property {string} description         Free-form longer description; used as button tooltip
 *                                        and may surface in future action listings.
 * @property {string} icon                FontAwesome class (without the style prefix)
 * @property {string[]} visibility        Subset of VISIBILITY values
 * @property {boolean} requiresDictionaryMatch
 * @property {string} system              Macro-aware system prompt template
 * @property {string} user                Macro-aware user prompt template
 */

// ===== Public API =====

/**
 * Builds a normalized action registry from a preset's raw `actions` object.
 * Invalid entries are skipped (and logged); the custom-action fallback is
 * applied if the preset lacks a usable one.
 *
 * @param {Record<string, any>|undefined} rawActions Preset's `actions` field
 * @param {ChatAction|null} [customFallback] Bundled default's custom action,
 *      injected if the preset's custom is missing/invalid. Pass `null` only
 *      when normalizing the bundled default itself.
 * @returns {{ actions: ChatAction[], byId: Map<string, ChatAction> }}
 */
export function buildActionRegistry(rawActions, customFallback) {
    const actions = [];
    const byId = new Map();

    if (rawActions && typeof rawActions === 'object') {
        for (const [id, raw] of Object.entries(rawActions)) {
            const action = normalizeAction(id, raw);
            if (!action) continue;
            if (byId.has(action.id)) {
                console.warn(`[${EXTENSION_NAME}] Duplicate action id "${action.id}" — keeping first.`);
                continue;
            }
            actions.push(action);
            byId.set(action.id, action);
        }
    }

    // Ensure a usable custom fallback exists so manual input always works.
    if (!byId.has(CUSTOM_ACTION_ID) && customFallback) {
        const cloned = { ...customFallback, visibility: [...customFallback.visibility] };
        actions.push(cloned);
        byId.set(cloned.id, cloned);
    }

    return { actions, byId };
}

/**
 * Returns actions whose visibility includes the given context, optionally
 * gated by dictionary-match availability.
 *
 * @param {ChatAction[]} actions
 * @param {string} context One of VISIBILITY.*
 * @param {Object} [opts]
 * @param {boolean} [opts.hasDictionaryMatch=true] When false, actions with
 *      `requiresDictionaryMatch: true` are filtered out.
 * @returns {ChatAction[]}
 */
export function getActionsForContext(actions, context, opts = {}) {
    const hasMatch = opts.hasDictionaryMatch !== false;
    return actions.filter(a => {
        if (!a.visibility.includes(context)) return false;
        if (a.requiresDictionaryMatch && !hasMatch) return false;
        return true;
    });
}

/**
 * Resolves the action ID to use for free-form / manual follow-up.
 * Prefers the canonical "custom" id; otherwise the first action with manual
 * visibility; otherwise null (caller should fall back to the global custom).
 *
 * @param {ChatAction[]} actions
 * @returns {string|null}
 */
export function findManualActionId(actions) {
    const custom = actions.find(a => a.id === CUSTOM_ACTION_ID && a.visibility.includes(VISIBILITY.MANUAL));
    if (custom) return custom.id;
    const anyManual = actions.find(a => a.visibility.includes(VISIBILITY.MANUAL));
    return anyManual ? anyManual.id : null;
}

// ===== Internal =====

/**
 * Validates and normalizes a single action entry. Returns null for entries
 * that cannot be safely used (missing prompts, invalid id, etc.).
 *
 * @param {string} id
 * @param {any} raw
 * @returns {ChatAction|null}
 */
function normalizeAction(id, raw) {
    if (!id || typeof id !== 'string') {
        console.warn(`[${EXTENSION_NAME}] Skipping action with invalid id:`, id);
        return null;
    }
    if (!raw || typeof raw !== 'object') {
        console.warn(`[${EXTENSION_NAME}] Skipping action "${id}" — definition is not an object.`);
        return null;
    }

    const system = typeof raw.system === 'string' ? raw.system : '';
    const user = typeof raw.user === 'string' ? raw.user : '';

    // Both prompts missing → nothing to send. Skip.
    if (!system && !user) {
        console.warn(`[${EXTENSION_NAME}] Skipping action "${id}" — no system or user prompt template.`);
        return null;
    }

    const label = (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim() : id;
    const description = (typeof raw.description === 'string') ? raw.description.trim() : '';
    const icon = (typeof raw.icon === 'string' && raw.icon.trim()) ? raw.icon.trim() : DEFAULT_ICON;
    const visibility = normalizeVisibility(raw.visibility, id);
    const requiresDictionaryMatch = Boolean(raw.requiresDictionaryMatch);

    return { id, label, description, icon, visibility, requiresDictionaryMatch, system, user };
}

/**
 * Normalizes a visibility array. Unknown values are dropped silently.
 * Falls back to DEFAULT_VISIBILITY if the result would be empty.
 * The custom action defaults to manual-only when nothing is specified.
 *
 * @param {any} raw
 * @param {string} id
 * @returns {string[]}
 */
function normalizeVisibility(raw, id) {
    if (Array.isArray(raw)) {
        /** @type {string[]} */
        const cleaned = [];
        for (const v of raw) {
            if (typeof v === 'string' && VALID_VISIBILITY.has(v) && !cleaned.includes(v)) {
                cleaned.push(v);
            }
        }
        if (cleaned.length > 0) return cleaned;
    }
    // Sensible default per action role.
    if (id === CUSTOM_ACTION_ID) return [VISIBILITY.MANUAL];
    return [...DEFAULT_VISIBILITY];
}
