# Architecture & Design Document

> Authoritative reference for the NihongoHelper project.
> Explains the **why** behind decisions, system architecture, data pipelines,
> algorithms, and extension patterns. Intended for both human developers and
> AI coding agents as a baseline for understanding and extending this project.

---

## 1. Vision & Philosophy

### What is NihongoHelper?

A **SillyTavern extension for learning Japanese through immersive chat**. Rather than treating language learning as a separate activity, it overlays linguistic information directly on the conversation — furigana, dictionary tooltips, kanji details, inflection analysis — and adds a meta tutor for Japanese-aware support during ongoing conversation, RP, and co-writing.

### Core Design Principles

1. **Passive Learning First** — Information on hover/glance, never forced. No interrupting popups or quizzes.
2. **Deterministic & Offline** — All analysis runs locally with bundled data. No network calls for core functionality.
3. **Non-Destructive** — Never modifies message data. Annotations are DOM overlays, original text preserved in `data-original`.
4. **Progressive Disclosure** — Furigana always visible → meanings on hover → all interpretations via pagination.
5. **Adaptive to Learner Level** — Per-kanji state (unknown / learning / known) drives furigana visibility, highlighting, and prompt macros, so the LLM can adapt difficulty to what the user already knows or is actively studying.
6. **SillyTavern-Native** — Uses ST's extension API, settings persistence, event hooks, UI conventions.

### Long-Term Goal

Build a complete Japanese immersion learning layer:
- Adapt LLM output difficulty to user's current level (via macros + system prompts)
- Instant in-context dictionary access for any word
- Track vocabulary exposure and known words over time
- Grammar pattern recognition and structured review
- Bridge passive reading into active recall (Anki export, session vocabulary)

**Key insight:** Roleplay chat provides unlimited, engaging, level-appropriate Japanese. The main LLM produces language to read and respond to; NihongoHelper helps the user understand it, ask about nuance and grammar, and write back more naturally without making the side tutor part of the fictional scene.

---

## 2. System Architecture

### Data Flow

```
Message HTML (from ST renderer)
  → onMessageFormatted hook (synchronous, before DOM insert)
  → Kuromoji tokenizer (morphological analysis → tokens with surface/reading/POS)
  → Token Matcher (sliding window dict lookup + deinflection + greedy spans)
  → Furigana Builder (ruby HTML + kanji wrapping + data attributes)
  → DOM: .nihongo-word spans with data-match-id
  → On hover: Tooltip retrieves stored matches, builds paginated pages
```

### Module Dependency Graph

```
index.js (entry point)
├── settings.js         (state, UI, CSS vars)
│   └── side-chat-prompts.js (preset list for settings dropdown)
├── furigana.js         (tokenization, DOM processing, event hooks)
│   ├── token-matcher.js  (multi-token matching, greedy spans, match store)
│   │   ├── meaning-provider.js → jmdict.js
│   │   └── deinflect.js
│   └── kanji-data.js
├── kanji-state.js      (unified per-kanji state map: unknown/learning/known + timestamps + legacy migration)
├── kanji-manager.js    (popup UI, tri-state selector, learning/known counts)
├── kanji-tooltip.js    (hover tooltip: kanji + word, positioning, pagination, nudge bar, tri-state controls)
│   ├── meaning-provider.js, deinflect.js, token-matcher.js (getStoredMatches)
│   ├── tracking.js (nudgeConfidence, getDerivedLevel, getConfidence)
│   ├── frequency.js (getFrequencyPercent, getFrequencyTier)
│   ├── furigana.js (reprocessMessagesWithKanji)
│   ├── side-chat.js (triggerChatAction — from tooltip action buttons)
│   ├── side-chat-prompts.js (getActiveActions — registry source)
│   └── side-chat-actions.js (getActionsForContext, VISIBILITY — filter buttons by context)
├── side-panel.js       (shared tabbed side panel: register, open, close, switch)
├── side-chat-actions.js (normalized ChatAction registry: validation, visibility filtering, custom-action fallback)
├── side-chat-prompts.js (preset system: JSON loader, user-preset index in extension_settings, import/export, registry-backed prompt lookups)
│   ├── side-chat-actions.js (buildActionRegistry, CUSTOM_ACTION_ID)
│   └── data/presets/*.json (bundled tutor presets, v3 schema)
├── side-chat-llm.js    (LLM call wrapper, macro substitution)
│   └── side-chat-prompts.js (getMainSystemPrompt, getActionInstructions, getUserPrompt)
├── side-chat.js        (chat tab UI, sessions, streaming, messageFormatting)
│   └── side-chat-llm.js, side-chat-prompts.js, side-chat-actions.js (findManualActionId, CUSTOM_ACTION_ID)
├── dict-search-ui.js   (side panel search tab, result cards)
│   └── dict-search.js  (3-phase search: direct → deinflect → Fuse)
│       ├── romaji.js    (romaji-to-hiragana conversion)
│       └── jmdict.js, deinflect.js, frequency.js
├── tracking.js         (word confidence tracking, file-based persistence)
├── frequency.js        (word frequency ranks, sigmoid percent, tiers)
├── wand-menu.js        (extensions menu)
└── macros.js           ({{knownKanji}}, {{knownKanjiCount}}, {{learningKanji}}, {{learningKanjiCount}})
```

---

## 3. Module Reference

### `index.js` — Entry Point

Called by ST via `manifest.json` hook `{ activate: "init" }`. Init order:
1. Settings (sync, ensure extension_settings namespace) → 2. Kanji state (sync, with legacy migration) → 3. Prompt presets (await: bundled presets + active preset → seeds the action registry and the preset dropdown list) → 4. Settings UI (await, renders dropdown with the up-to-date preset list) → 5. Furigana system (await, registers hooks) → 6. Kanji Manager → 7. Side panel tabs (Search + Chat) → 8. Wand menu → 9. Inspect shortcut + Search shortcut → 10. Selection lookup → 11. Macros → 12. Meaning provider (async, non-blocking) → 13. Word tracking (async, non-blocking) → 14. Frequency data (async, non-blocking)

**Why this order:** Settings first (everything reads them). Presets before the settings UI so the tutor preset dropdown shows imported user presets on first render and so the side-chat action registry is ready before any tooltip/chat action can fire. Furigana hooks before any messages render. JMdict, tracking, and frequency all load in background — furigana works immediately, tooltips/badges become available once loaded.

### `src/furigana.js` — Tokenization & DOM Processing

**Processing path:** `onMessageFormatted` hook → parse HTML into temp container → TreeWalker finds Japanese text nodes → tokenize → `analyzeTokens` (greedy spans) → `buildRuby` (ruby HTML) → replace text nodes with `<span class="nihongo-processed">`.

**Why `onMessageFormatted` (not event-based):** Originally used render events, but race conditions with streaming. The formatting hook is synchronous, runs on EVERY render path (streaming, edits, swipes) — one consistent path, no duplicates.

**`buildRuby` algorithm:** For mixed kanji/kana tokens (e.g., `食べる` reading `たべる`): split surface into kanji/kana parts → strip matching kana from reading front/back → remaining reading goes as `<rt>` over kanji block only. Cleans non-kana chars (zero-width spaces, markdown punctuation) before comparison.

**Event hooks:** `CHAT_CHANGED` (full re-process), `MESSAGE_EDITED/UPDATED` (single message), `MESSAGE_SWIPED/MORE_MESSAGES_LOADED` (batch re-process).

### `src/token-matcher.js` — Multi-Token Matching

Bridges single-token kuromoji output with multi-word JMdict entries (e.g., `食べ物` split into `食べ`+`物`).

**Algorithm:**
1. **Build Match Map** — sliding window of 1..N tokens. For each window: direct lookup → katakana variant → deinflection. **Skips windows with whitespace** (LLM-inserted spaces cause false positives via reading fallback).
2. **Greedy Spans** — longest match first, with one-round overlap extension for compound words that start mid-span. Collects all sub-matches within final span boundaries.
3. **Match Storage** — `Map<spanId, MatchEntry[]>`, span ID embedded in DOM as `data-match-id`. Tooltip reads this to retrieve match data.

**Why skip whitespace surfaces:** LLMs insert spaces between Japanese words. Kuromoji emits space tokens. Joining across them produces surfaces like `やさしい ` — surface lookup fails, but clean reading `やさしい` matches via fallback → false positive merges separate words into one span.

### `src/deinflect.js` — De-inflection

Suffix-based rules covering ~100 verb/adjective inflection patterns. Returns candidate dictionary forms; caller verifies against JMdict. Single-step only (multi-step chains planned for future).

### `src/jmdict.js` — Dictionary Layer

Loads `data/jmdict.json`, builds index `Map<string, number[]>` (kanji forms + kana readings → entry indices, common-first sorted). Lookup: try surface first, fall back to reading.

### `src/meaning-provider.js` — Provider Abstraction

Pluggable backend architecture. Currently JMdict only. Standard result shape: `{ word, readings, forms, common, senses: [{ pos, glosses, misc, info, field }], source }`.

### `src/kanji-tooltip.js` — Tooltip System (~1600 lines)

Delegated hover detection → show/hide state machine (300ms show, 400ms hide) → paginated word tooltips OR compact kanji tooltips → smart positioning (right→left→below, constrained to viewport) → scroll navigation (Shift+Scroll anywhere, plain scroll on tab list only) → position adjustment (only upward, never back down to prevent jitter) → selection lookup (select text to look up) → inspect mode → nudge bar (confidence tracking buttons) → frequency badges.

**Word tooltip header:** Word + reading + common badge (icon-only when freq present, text otherwise) + frequency percentage badge (colored by tier, rank in title attribute) + search/copy action buttons.

**Nudge bar:** Rendered below tooltip body. Buttons: Easy/Got it/Meh/Hard (confidence nudges), Anki (flag toggle), Reset. Confidence fill bar + level/percentage label. Mutually exclusive selection with undo (clicking same button restores pre-nudge state). Session-persisted selections via `nudgeSelections` Map.

**Why delegated events:** Chat messages are dynamic. One listener on container works with all content, zero cleanup on message change.

### `src/kanji-state.js` — Unified Kanji State

Single source of truth for per-kanji learning state. Replaces the old `knownKanji` set.

**Storage:** `extension_settings.nihongo_helper.kanjiState` — only `learning` / `known` entries are persisted; absent = unknown.

```js
{
  "食": { state: "learning", learningSince: ISO, updatedAt: ISO },
  "見": { state: "known",    knownSince: ISO,    updatedAt: ISO,
          learningSince?: ISO  // preserved across promotion }
}
```

**State semantics:**

- `setState(char, 'unknown')` — deletes the entry entirely.
- `setState(char, 'learning')` — idempotent if already learning; from `known`, demotes (clears `knownSince`, keeps `learningSince`); from `unknown`, stamps `learningSince=now`.
- `setState(char, 'known')` — idempotent if already known; from `learning`, promotes (stamps `knownSince=now`, preserves `learningSince`); from `unknown`, stamps `knownSince=now`.

**Public API:** `loadKanjiState()`, `getState(char)`, `getStateEntry(char)`, `setState(char, newState)`, `cycleState(char)`, `isKnown(char)`, `isLearning(char)`, `getKnownKanji()` / `getLearningKanji()` (snapshot maps), `getKnownChars()` / `getLearningChars()`.

**Legacy migration:** `loadKanjiState()` reads `settings.knownKanji` (array OR object char→ISO date) on first load, populates the unified map with `state: 'known'`, then deletes the legacy key. One-shot, no ongoing dual-write.

### `src/kanji-manager.js` — Kanji Browser

Grid popup with 2998 kanji. Filter by JLPT/grade/learning state (unknown / learning / known). Sort by freq/grade/JLPT/strokes. The detail view exposes a tri-state segmented selector + `Learning since` / `Known since` rows. Tile classes `.nihongo-km-tile-known` (green) and `.nihongo-km-tile-learning` (blue) reflect current state. Space cycles unknown→learning→known→unknown; Shift+Space jumps directly to/from known. State storage lives in `kanji-state.js`.

### `src/romaji.js` — Romaji-to-Hiragana Conversion

Longest-prefix table lookup (~100 mappings). Supports Hepburn + common variants (si→し, ti→ち). Handles double consonants (kk→っ), n-before-consonant (→ん). Used by dict-search to enable romaji input (e.g., "ireru" → いれる → 入れる).

**Why not a full IME:** Only needed for search input, not text composition. Simple table approach is deterministic and fast.

### `src/frequency.js` — Word Frequency

Loads `data/frequency.json` (JPDB list, ~477K entries). Provides:
- `getCompositeFrequency(word, reading)` — raw rank (lower = more common)
- `getFrequencyTier(word)` — categorical: top1k, top5k, top15k, common, rare
- `getFrequencyPercent(word)` — 0–100% sigmoid display score

**Percent formula:** `100 / (1 + (rank / 15000)^0.8)` — a sigmoid curve where:
- Rank ~300 → 95% (extremely common)
- Rank ~1000 → 90% (very common)
- Rank ~5000 → 70% (fairly common)
- Rank ~15000 → 50% (midpoint, roughly N1 boundary)
- Rank ~50000 → 28% (uncommon)

**Why sigmoid, not log:** The previous `1 - log(rank)/log(total)` formula gave rank #331 only 56% in a 530K-word list. The sigmoid maps Zipf-distributed ranks to intuitive learner percentages — top-1k words should *feel* like 90%+.

### `src/dict-search.js` — Dictionary Search Engine

Three-phase search strategy ensuring exact matches always rank first:

1. **Direct index lookup** (rank 0) — Exact kanji/kana form match via JMdict index. Handles romaji input by converting to hiragana first.
2. **Phase 1b: Direct English gloss matching** (rank 0–0.01) — For non-Japanese queries, scans all entries' individual glosses for exact/starts-with/substring matches. Avoids Fuse.js penalizing entries with many glosses. Sorting: match quality → common → frequency.
3. **Deinflection** (rank 0.02) — Applies `deinflect()` to the query, verifies candidates against JMdict. Returns results with `inflection` and `inflectedForm` metadata.
4. **Fuse.js fuzzy search** (rank 0.4+) — Multi-field (glosses, kanji, reading) fuzzy match. Composite scoring: prefix overlap, frequency, common flag.

Deduplication by entry object identity. Tie-breaking: common first → frequency rank.

**Why Phase 1b before Fuse:** Fuse.js scores on concatenated gloss strings, penalizing entries with many senses (long strings). "to put in" would miss 入れる because Fuse ranks shorter-glossed entries higher. Phase 1b guarantees substring-level matches regardless of entry size.

### `src/dict-search-ui.js` — Search UI (Side Panel Tab)

Registers "Search" tab in side panel. Debounced input (200ms) triggers `searchDictionary()`. Result cards show: word (with tooltip on hover), reading, frequency badge, inflection note (if deinflected), condensed inline glosses with action buttons.

**Gloss layout:** All senses shown inline (not just first 2-3). First 3 senses: up to 3 meanings each; remaining: up to 2. Non-copyable dot separators (`::before` pseudo-elements). POS as tooltip on each definition span. Max height ~3 lines with overflow hidden.

**Action buttons:** Position absolute bottom-right with gradient mask. Appear on hover via opacity transition. `pointer-events: none` when hidden to keep text selectable.

**Word tooltip:** The word element gets `nihongo-word` class + `data-word`/`data-reading` attributes, and `attachKanjiTooltip` is applied to the results container. Tooltip positions relative to the card (not the word span) to avoid covering the card content.

### `src/macros.js` — ST Macros

Global macros backed by `kanji-state.js`:

- `{{knownKanji}}` — comma-separated list of kanji marked `known`.
- `{{knownKanjiCount}}` — size of the known set.
- `{{learningKanji}}` — comma-separated list of kanji marked `learning`.
- `{{learningKanjiCount}}` — size of the learning set.

Use known macros to keep the LLM at the user's current vocabulary ceiling, and learning macros to bias it toward kanji the user is actively studying (the model is encouraged to *use* those kanji naturally; furigana stays visible because they are not yet known).

### `src/side-panel.js` — Shared Side Panel

VSCode-style tabbed panel that slides in from the right (or left, configurable via `panelSide` setting). Different views (Search, Chat) register as tabs and provide their own content. Only one tab visible at a time.

**Public API:** `registerTab(id, { icon, label, build, onActivate, onDeactivate })`, `openSidePanel(tabId)`, `closeSidePanel()`, `toggleSidePanel(tabId)`, `isSidePanelOpen()`, `switchTab(tabId)`, `registerSearchShortcut()` (Ctrl+Shift+F), `insertIntoChatInput(text)`.

**Design:** Lazy-builds tab views on first activation. Saves/restores cursor position in chat input when opening/closing. Escape closes panel when focus is inside it. Left/right positioning controlled by `nihongoSettings.panelSide` with reactive CSS class toggling.

### `src/tracking.js` — Word Confidence Tracking

Sliding confidence model for per-word familiarity. Stores confidence score (0–1), encounter counts, timestamps, and user flags. Confidence nudged by intuitive button clicks (Easy/Got it/Meh/Hard) rather than absolute levels.

**Storage:** In-memory `Map<string, WordEntry | CompactEntry>`, persisted via ST's files endpoint as `user/files/nihongo-tracking.json`. Debounced save every 30s + save on `beforeunload`/`visibilitychange`. Separate from `extension_settings` to avoid bloating settings saves.

**Data model:** Two entry tiers:
- **CompactEntry** `{ s, l }` — auto-tracked only (seen count + last seen date). Created on first passive encounter.
- **WordEntry** (full) — promoted from compact on first user interaction. Includes `confidence`, `seenCount`, `usedCount`, `firstSeen`, `lastSeen`, `lastUsed`, `lastInteraction`, `flags[]`.

**Confidence nudges:** EASY (+0.20), GOT_IT (+0.10), MEH (-0.05), HARD (-0.15), SEEN (+0.01 diminishing), USED (+0.05), FIRST_SEEN (0.05 seed). Passive exposure has diminishing returns: `0.01 * (1 / (1 + seenCount/20))`.

**Derived levels** (for furigana/difficulty decisions, not shown directly to user): Mastered (≥0.85), Known (≥0.60), Familiar (≥0.30), Seen (≥0.10), Unknown (<0.10).

**Public API:** `loadTracking()`, `getWordEntry(word)`, `getConfidence(word)`, `getDerivedLevel(word)`, `recordSeen(word)`, `recordUsed(word)`, `nudgeConfidence(word, action)`, `toggleFlag(word, flag)`, `setConfidence(word, value)`, `resetConfidence(word)`, `getWordsAbove(minConfidence)`, `getTrackedCount()`.

### Language Assistant Side Chat

Four-module architecture for the side chat feature:

**`src/side-chat-actions.js`** — Action registry & validator. Owns the normalized `ChatAction` shape (`id`, `label`, `description`, `icon`, `visibility`, `requiresDictionaryMatch`, `system`, `user`) and the `VISIBILITY` constants (`tooltip` / `selection` / `manual`). `buildActionRegistry(rawActions, customFallback)` validates each preset entry, fills in defaults for missing label/icon/visibility, skips entries with no usable prompt, and ensures a usable `custom` action is always present (falling back to the bundled default's `custom`). Consumers query the registry via `getActionsForContext(actions, ctx)` and `findManualActionId(actions)`.

**`src/side-chat-prompts.js`** — Prompt Preset System. Presets are JSON files with:
- `systemPrompt` — stable template (cacheable across all turns)
- `personality`, `description`, `rules` — content fields exposed as dynamic macros
- `actions` — declarative per-action JSON, consumed by `side-chat-actions.js`. Each action declares its own `label`, `icon`, `visibility`, prompts, etc.
- Templates use namespaced `{{nihongoWord}}`, `{{nihongoSentence}}`, etc. macros

Bundled default preset at `data/presets/default.json`. User presets are uploaded to `user/files/nihongo-preset-<slug>.json` via the standard files endpoint and tracked in `extension_settings.nihongo_helper.userPresets` (no directory-listing endpoint required). Active preset selected in settings, loaded at init.

Key API:
- `getMainSystemPrompt()` — stable system prompt template.
- `getActionInstructions(actionId)`, `getUserPrompt(actionId)` — per-action prompt lookups (fall back to the registry's custom action when the requested id is unknown).
- `getAction(actionId)`, `getActiveActions()` — read the normalized registry built from the active preset.
- `initPresets(id)` / `loadPreset(id)` — load bundled presets + the requested preset.
- `exportActivePreset()` / `importPresetFromJson(text)` / `deleteUserPreset(id)` / `isUserPreset(id)` — preset I/O surface used by the settings UI.

**`src/side-chat-llm.js`** — LLM call wrapper. Handles:
- Connection Manager profile-based requests (streaming + non-streaming) using `ConnectionManagerRequestService.sendRequest`
- Streaming: if `onStream` callback provided, attempts `stream: true` first. Consumes async generator, relays `{text, reasoning}` chunks.
- Non-streaming fallback: `extractData: true` path
- `generateRaw` fallback: when no profile configured, uses ST's main model (no streaming/reasoning)
- Abort support via `AbortSignal`
- Dynamic macros built as `MacroDefinitionOptions` objects with handler functions, namespaced (`nihongoWord`, `nihongoSentence`, etc.)
- Prompts loaded from active preset via `getSystemPrompt`/`getUserPrompt` (no hardcoded templates)

**`src/side-chat.js`** — Chat tab UI and session management:
- Registers "Chat" tab in side panel via `registerTab('chat', ...)`
- `triggerChatAction(actionId, context)` — public API called from tooltip buttons. Opens panel, adds user action message, sends to LLM.
- **Message rendering:** Uses `messageFormatting()` from ST's main renderer for both content and reasoning. This gives markdown, custom regex, and furigana (via `onMessageFormatted` hook) automatically.
- **Reasoning auto-scroll:** During streaming, reasoning block scrolls to bottom (`scrollTop = scrollHeight`), matching ST's main `StreamingDisplay` behavior.
- Chat session data model: `ChatSession` → `ChatMessage[]`, each with `id`, `role`, `content`, `reasoning`, `timestamp`, `context`, `meta`.
- Streaming: assistant messages update in-place as chunks arrive. Reasoning blocks start expanded, auto-collapse when content starts streaming. Header updates to "Thought for x seconds" when done.
- Multi-turn: conversation history sent to LLM (last 10 messages).
- Free-form input: typing in the input bar sends a follow-up.

**Tooltip integration** (`src/kanji-tooltip.js`):
- Word tooltips and the minimal selection tooltip render their action buttons from the active preset's registry via `renderChatActionsHtml(word, reading, ctx)`. The HTML helper filters the registry by visibility (`VISIBILITY.TOOLTIP` for hover/selection-with-match, `VISIBILITY.SELECTION` for the minimal no-match tooltip) and HTML-escapes preset-supplied label/icon/id values.
- Buttons share the existing `.nihongo-wt-chat-actions` / `.nihongo-wt-chat-btn` styling. The container is omitted entirely when no actions match the context, so an empty preset doesn't leave a stray border.
- Click handler reads `data-chat-action` from the button and forwards the id (any preset-defined id) to `triggerChatAction()`. It still uses `hoveredTarget` to find the containing `.mes_text` and extract a context sentence directly (not text search), so inflected forms keep working.
- Reading is NOT passed to the LLM (dictionary reading may not match contextual reading — e.g., 文 as ぶん vs ふみ). The LLM determines reading from context.
- **Selection fallback:** When selecting Japanese text with no dictionary match, a minimal tooltip with just the word + selection-visible action buttons is shown via `showMinimalSelectionTooltip()`. Actions with `requiresDictionaryMatch: true` are excluded.

**Settings** (`templates/settings.html`, `src/settings.js`):
- "Language Assistant" section with Connection Manager profile dropdown and tutor preset selector
- `chatProfileId`, `chatPresetId`, and `userPresets` (array of imported-preset metadata) persisted in extension_settings
- Profile list refreshed on connection profile events
- Preset list populated from `getPresetList()` (bundled presets + entries from `extension_settings.nihongo_helper.userPresets`)
- Preset Import / Export / Delete buttons next to the dropdown (`registerPresetIoHandlers`): Import opens a hidden `<input type="file">` and pipes the selected JSON through `importPresetFromJson`; Export dumps `exportActivePreset()` as a downloaded `nihongo-preset-<id>.json`; Delete (only for user presets) confirms via `Popup.show.confirm`, calls `deleteUserPreset()`, and reverts to the bundled default. Bundled presets are non-deletable.

### Side Chat — Prompt Building Flow

This section documents the current v2/v3 prompt architecture and the historical problems it solved (v1 flat array approach).

#### Historical Problem: v1 Flat Prompt Array

The original design used a flat messages array: `[system, ...history, user]` with a combined system prompt that changed per request. This caused several issues:

- **System prompt mutation** — Each action rebuilt personality+action system prompt. Prior history turns were generated under different instructions, creating mixed signals for the LLM.
- **UI text in history** — History stored display labels like `"Grammar: 書きます"` instead of the full prompts actually sent to the LLM.
- **Consecutive user messages** — New actions in existing sessions added display messages to history immediately followed by the actual user prompt.
- **Context macro inconsistency** — `{{nihongoWord}}` in the system prompt reflected only the latest action's context, not the context of prior history turns.
- **No prompt caching** — The ever-changing system prompt defeated API-level prefix caching (longest stable prefix was zero tokens).

These problems motivated the v2 architecture refactor.

#### Current Architecture (v2/v3 Implemented)

The goal: **stable cacheable prefix, self-contained turns, action instructions at depth, configurable history handling.**

##### Preset Format v2

```json
{
    "v": 2,
    "name": "Default Tutor",
    "description": "A concise Japanese tutor for in-context word and grammar questions.",
    "personality": "You are a concise Japanese language tutor...",
    "rules": "- Be concise.\n- Match level to student ({{nihongoKnownKanjiCount}} kanji known).\n...",
    "systemPrompt": "{{nihongoPersonality}}\n\nGeneral rules:\n{{nihongoRules}}",
    "actions": {
        "explain": { "system": "...", "user": "..." },
        "grammar": { "system": "...", "user": "..." },
        "custom":  { "system": "...", "user": "..." }
    }
}
```

- `systemPrompt` is a **template** composing other preset fields via macros (`{{nihongoPersonality}}`, `{{nihongoDescription}}`, `{{nihongoRules}}`). Stays identical for the entire session — cacheable.
- `description`, `personality`, `rules` are raw content fields, registered as dynamic macros from the active preset.
- `actions[id].system` = action-specific instructions injected at depth (just before user message).
- `actions[id].user` = user message template with context macros (`{{nihongoWord}}`, `{{nihongoSentence}}`, etc.).

##### Message Array Layout

```
┌─────────────────────────────────────────────────────────┐
│ messages[0]: system  (STABLE — main system prompt)      │
│   = preset.systemPrompt template, macro-substituted     │
│   Identical across all turns in a session. Cacheable.   │
├─────────────────────────────────────────────────────────┤
│ messages[1..N-2]: history                               │
│   Interleaved system/user/assistant triples or pairs    │
│   depending on "history system handling" setting.       │
│   User msgs = full prompt text (not display labels).    │
│   Assistant msgs = full response.                       │
│   System msgs = action instructions (if retained).     │
├─────────────────────────────────────────────────────────┤
│ messages[N-1]: system  (AT DEPTH — action instructions) │
│   = preset.actions[actionId].system (macro-substituted) │
│   Current turn's action rules. Always present.          │
├─────────────────────────────────────────────────────────┤
│ messages[N]: user  (current request)                    │
│   = preset.actions[actionId].user (macro-substituted)   │
│   Fully self-contained: includes word, context, etc.    │
└─────────────────────────────────────────────────────────┘
```

##### History System Message Handling (User Setting)

Setting: **"Action instructions in history"** — dropdown with options:

| Mode | Behavior | Best for |
|------|----------|----------|
| **Remove** | Strip all old system-at-depth from history. Only current turn has action instructions. | Max cache efficiency, minimal repetition |
| **Deduplicate** | First occurrence of each action type kept in full. Subsequent same-type become `[Same instructions as '{action}' above]`. Current turn always full. One action type appears at most 2× in the array. | Balance of context and brevity |
| **Keep last N** | Keep the last N system-at-depth messages (number input). Older ones stripped. Current turn always present regardless of N. | Users who want more context at cost of tokens |

Default: **Remove** (cleanest, best cache behavior, models infer format from prior responses).

##### ChatMessage Data Model

```js
/** @typedef {Object} ChatMessage
 * @property {string} id
 * @property {'user'|'assistant'} role
 * @property {string} content        - Short display text (shown in UI bubble)
 * @property {string} [prompt]       - Full user prompt sent to LLM (for history reconstruction + expandable peek)
 * @property {string} [instructions] - Action system-at-depth active for this turn (for UI peek + optional history inclusion)
 * @property {string} [actionId]     - Which action produced this turn (for dedup logic)
 * @property {string} [reasoning]    - Model reasoning/thinking (assistant only)
 * @property {Object} [context]      - Word/sentence context
 * @property {Object} [meta]         - Model info, timing, profileId
 * @property {string} timestamp
 */
```

- UI renders `content` in the bubble.
- LLM history uses `prompt` for user messages, `content` for assistant messages.
- `instructions` stored for UI peek and optional history inclusion per setting.
- `actionId` enables the dedup logic ("same as X above").

##### UI Rendering

```
┌──────────────────────────────────────────────────────────┐
│ ┌─ ⚙ Grammar instructions ─────────────────── ▸ ┐      │  ← collapsed system bar
│ └────────────────────────────────────────────────┘      │     (click ▸ to expand inline)
│                                                          │
│              ┌──────────────────────────────┐            │
│              │ Grammar: 書きます      [⋯]  │            │  ← user bubble (short content)
│              └──────────────────────────────┘            │     [⋯] expands full prompt
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ This is 書きます (kakimasu), the polite form... │    │  ← assistant bubble
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│ ┌─ ⚙ [Same as 'Grammar' above] ─────────── ▸ ┐        │  ← deduped system bar
│ └────────────────────────────────────────────────┘      │     (expandable to show full)
│                                                          │
│              ┌──────────────────────────────┐            │
│              │ Grammar: 食べる        [⋯]  │            │
│              └──────────────────────────────┘            │
└──────────────────────────────────────────────────────────┘
```

- System bars: subtle, single-line, muted styling. Icon + action label. Click to expand full text inline.
- User bubbles: show `content` (short). `[⋯]` button toggles `prompt` (full text) below.
- Expansion state is ephemeral (collapsed on reload) — no persistence needed.
- All data persists on ChatMessage for session save/restore.

##### Why This Layout

- **Stable prefix** — `messages[0]` + history form a growing but stable prefix. API-level caching (Anthropic, OpenAI) reuses everything up to the last system-at-depth + user message.
- **Self-contained history** — Each user prompt contains word, context, question. Readable without system prompt. Topic switches are coherent.
- **Action instructions at depth** — Steer current response format without contaminating personality or conflicting with prior turns.
- **No consecutive user messages** — History has clean pairs (or triples with system). No model confusion.
- **Configurable repetition** — User controls whether old instructions appear in context. Power users can keep more; default removes them.

##### Implementation Status (Completed)

All v2 refactoring has been implemented:

1. **Preset format v2** (`data/presets/default.json`, `src/side-chat-prompts.js`) — `systemPrompt` template composes `{{nihongoPersonality}}` and `{{nihongoRules}}` macros. `description`, `personality`, `rules` are separate content fields. `getPresetFieldMacros()` exposes them as dynamic macros.
2. **Prompt split** (`src/side-chat-prompts.js`) — `getMainSystemPrompt()` returns stable template; `getActionInstructions(actionId)` returns per-action system text.
3. **`buildPrompts()`** (`src/side-chat-llm.js`) — Builds and substitutes all prompts (main system, instructions, user prompt). Returns `BuiltPrompts` for storage + LLM call.
4. **`ChatMessage` extended** (`src/side-chat.js`) — Added `prompt`, `instructions`, `actionId` fields. `generateResponse` stores them after building prompts.
5. **`buildMessages()`** (`src/side-chat-llm.js`) — Layout: `[stable system] + [history] + [system-at-depth] + [user]`.
6. **`buildHistoryForLLM()`** (`src/side-chat.js`) — Uses `msg.prompt` for user content, applies history mode setting (remove/deduplicate/keep_last_n), respects `chatMaxHistory` limit.
7. **Settings** (`src/settings.js`, `templates/settings.html`) — `chatHistoryMode` (default: remove), `chatHistoryKeepN` (default: 3), `chatMaxHistory` (default: 20). UI with dropdown + range sliders.
8. **UI rendering** (`src/side-chat.js`, `style.css`) — Collapsible system bars (icon + action label, click to expand full instructions). `[⋯]` prompt peek button on user messages to toggle full prompt text.
9. **Preset migration** (`src/side-chat-prompts.js`) — `migrateV1ToV2()` handles legacy presets: `systemPrompt = "{{nihongoPersonality}}"`, personality stays as-is, `rules = ""`.
10. **`sendChatRequest`** (`src/side-chat-llm.js`) — Now accepts pre-built prompts instead of building internally. `generateRaw` fallback concatenates main system + instructions.

---

## 4. Data Pipeline

All processed data files are **committed to the repository** — users never need to run build scripts. The scripts exist for developers to update or rebuild data from upstream sources.

### Kanji Data
- **Source:** [davidluzgouveia/kanji-data](https://github.com/davidluzgouveia/kanji-data) (KANJIDIC2-derived)
- **Output:** `data/kanji.json` (425KB, 2998 entries)
- Format: `{ k, s, g, f, jlpt, m, on, kun, i }`

### JMdict Dictionary
- **Source:** [scriptin/jmdict-simplified](https://github.com/scriptin/jmdict-simplified) (CC BY-SA 4.0)
- **Output:** `data/jmdict.json` (3.5MB, ~22.5K common entries)
- Format: `{ v, date, src, tags, words: [{ k?, r, c?, s: [{ p, g, m?, i?, f? }] }] }`
- Max 5 senses, 5 glosses per entry

### Word Frequency
- **Source:** [JPDB frequency list](https://github.com/MarvNC/jpdb-freq-list) (Yomitan format, 477K entries)
- **Output:** `data/frequency.json` (~16MB)
- Format: `{ v, builtAt, lists: { key: { name, count } }, words: { word: { listKey: rank } } }`
- Multiple list support (currently JPDB only); composite scoring with configurable weights

### Kuromoji Tokenizer
- Pre-built browser UMD bundle + `.dat.gz` dictionaries in `lib/kuromoji/` (~18MB)
- **Why bundled:** ST extensions are client-side only. No server component possible. Kuromoji runs in-browser, deterministic, fast (<50ms/message). Bundled for fully offline operation.

### Tutor Presets
- **Bundled:** `data/presets/default.json`, `strict.json`, `immersion.json`, and `anime-geek.json` (v3 schema), listed in `BUNDLED_PRESET_FILENAMES`
- **User presets:** uploaded to `user/files/nihongo-preset-<slug>.json` via the standard `/api/files/upload` endpoint and indexed in `extension_settings.nihongo_helper.userPresets`. The flat naming scheme avoids the `validateAssetFileName` constraint (no `/` in upload names) and we don't need the missing `/api/files/list` endpoint to discover them.
- Format (v3): `{ v, name, description, personality, rules, systemPrompt, actions: { <id>: { label, description, icon, visibility, requiresDictionaryMatch, system, user } } }`
- `systemPrompt` is a stable template composing `{{nihongoPersonality}}` and `{{nihongoRules}}` — identical for all turns (cacheable)
- `personality`, `description`, and `rules` are raw content fields exposed as dynamic macros
- `actions[id].system` = action-specific instructions injected at depth (before user message)
- `actions[id].user` = user message template with context macros
- `actions[id].label` / `description` / `icon` / `visibility` / `requiresDictionaryMatch` drive tooltip/selection/manual button rendering — all data-driven, validated by `buildActionRegistry`. `description` is user-facing metadata, currently used as the button tooltip.
- Visibility values: `tooltip` (word tooltip), `selection` (no-dictionary-match selection tooltip), `manual` (free-form follow-up). Unknown values are dropped silently.
- Bundled tutor presets: **Default Tutor** (balanced context help), **Strict Tutor** (correction/study precision), **Immersion Companion** (conversation-flow support), and **Anime Geek Tutor** (anime/media/RP dialogue, slang, character voice, and real-life naturalness checks). Action IDs differ by preset and are fully data-driven.
- Templates use `{{nihongoWord}}`, `{{nihongoSentence}}`, `{{nihongoKnownKanjiCount}}`, `{{nihongoLearningKanjiCount}}`, `{{nihongoLearningKanji}}` etc.
- Legacy v1 / v2 presets auto-migrated by `migrateToCurrent()`. Action-level metadata defaults (label/icon/visibility) are filled in by the registry, so older presets continue to work — they just look like a v3 preset where every action defaults to `[tooltip, selection]` visibility.

### Build Scripts

> **Note:** These are for development only. All output files are committed to the repo.

All scripts are in `scripts/` and require Node.js. Run from the extension root directory.

#### `build-kanji-data.cjs` — Rebuild kanji data

Processes raw KANJIDIC2-derived JSON into the lean format used by the Kanji Manager. Includes only kanji with a school grade or JLPT level (2998 kanji). Sorts by newspaper frequency.

```sh
# Requires: data/kanji-raw.json (manually downloaded from davidluzgouveia/kanji-data)
node scripts/build-kanji-data.cjs
# Output: data/kanji.json
```

#### `build-jmdict.cjs` — Rebuild JMdict dictionary

Downloads the latest jmdict-simplified release from GitHub, extracts the `.tgz`, and processes it into a compact lookup format. Limits to 5 senses and 5 glosses per entry. Preserves common-word flags.

```sh
node scripts/build-jmdict.cjs --download        # Download latest common-only + process
node scripts/build-jmdict.cjs --download --full  # Download full dictionary (not just common)
node scripts/build-jmdict.cjs                    # Re-process existing data/jmdict-raw.json
# Output: data/jmdict.json
```

#### `download-frequency.cjs` — Download & build frequency data

All-in-one script: fetches the latest JPDB frequency list (Yomitan format) from GitHub, extracts the ZIP, and feeds it into `build-frequency.cjs`. Caches the download for re-runs.

```sh
node scripts/download-frequency.cjs          # Download + build (uses cache if available)
node scripts/download-frequency.cjs --force  # Force re-download
# Output: data/frequency.json
```

#### `build-frequency.cjs` — Frequency data pipeline

Lower-level tool for managing multiple frequency lists. Reads Yomitan-format frequency dictionaries (extracted ZIPs with `term_meta_bank_*.json` files) and merges them into a single output. Supports adding, removing, and listing frequency sources.

```sh
node scripts/build-frequency.cjs --add <name> <path>  # Add/update a frequency list from extracted Yomitan dict
node scripts/build-frequency.cjs --remove <name>       # Remove a frequency list
node scripts/build-frequency.cjs --list                # Show current frequency lists
node scripts/build-frequency.cjs --rebuild             # Rebuild output from saved sources
# Output: data/frequency.json
```

---

## 5. Key Trade-offs

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Bundled kuromoji (~18MB) | Large repo (~50MB) | Fully offline, deterministic, no server, no CDN dependency |
| Common-only JMdict (3.5MB) | Misses rare words | 95%+ conversation coverage |
| Single-step deinflection | Misses compound inflections | Simple, covers most cases |
| No `<rp>` tags | No ancient browser fallback | ST = modern Chromium; eliminates flash bug |
| Greedy longest-match | May occasionally group wrong | Pragmatic vs exponential combinatorics |
| No bundler/build step | No minification | ST serves extensions as-is; simplicity wins |
| HTML string concatenation | Not reactive/virtual DOM | Matches ST patterns; performant at this scale |
| `messageFormatting` in side chat | Couples to ST internals | Consistent rendering (markdown, regex, furigana hooks). One function gives all formatting for free. |
| Preset JSON files (not settings) | Requires file endpoint | Presets can be large, shareable, git-friendly. Settings only hold the active id and a small index of imported user presets. |
| Flat preset filenames (`nihongo-preset-<slug>.json`) instead of a `nihongo-presets/` subfolder | Slight prefix noise in `user/files/` | Avoids the `validateAssetFileName` no-slash constraint on uploads and dodges the missing `/api/files/list` endpoint. |
| Action registry built from preset JSON | Preset edits drive button surface | Adding/renaming/removing actions is a JSON change. `buildActionRegistry` validates each entry and falls back to the bundled custom action so free-form input always works. |
| No reading in LLM context | LLM must infer reading | Dictionary reading often wrong for context (文=ぶん/ふみ). LLM does better with sentence context. |
| History stores full prompt (v2) | More data per session | Each user message stores `prompt` (full) + `content` (display). LLM history uses `prompt` for accurate multi-turn. |
| Stable system + action-at-depth (v2) | Slightly more complex prompt building | System prompt stays identical across all turns (cacheable). Action instructions injected at depth just before user message. |

---

## 6. Extension Patterns

### Adding a Setting
1. Default in `settings.js` → `defaultSettings`
2. Getter in `nihongoSettings`
3. HTML in `templates/settings.html`
4. Wire listener in `registerSettingsEventListeners()`

### Adding a Dictionary Provider
1. Implement `{ load, lookup, lookupAll? }` conforming to result shape
2. `registerProvider('name', provider)` in meaning-provider.js

### Adding Deinflection Rules
`tryRule(word, fromSuffix, toSuffix, ruleName, candidates)` in deinflect.js

### Adding a Tutor Preset
1. Open Settings → Nihongo Helper → Language Assistant → click the **Export** button next to the preset dropdown to download a copy of the active preset as a starting point.
2. Edit the JSON: tweak `personality`, `rules`, `systemPrompt`, and the `actions` map. Each action declares its own `label`, `icon`, `visibility` (`tooltip` / `selection` / `manual`), and `system` / `user` prompt templates. Use `{{nihongoWord}}`, `{{nihongoSentence}}`, `{{nihongoKnownKanjiCount}}` (and `{{nihongoLearningKanji}}` to bias toward kanji the student is actively studying) macros.
3. Click the **Import** button and select your JSON file. The preset is uploaded to `user/files/`, registered in extension_settings, selected in the dropdown, and ready to use immediately. Use the trash icon to delete user presets.
4. Manually placing files into `user/files/` is also supported — just name them `nihongo-preset-<id>.json` and add a matching entry to `extension_settings.nihongo_helper.userPresets` (id, fileName, name). The Import button is the easier path.

### Adding a Side Chat Action
1. Open the Tutor Preset JSON (Export → edit → Import).
2. Add a new entry under `actions`, keyed by a stable id:
   ```json
   "literal": {
       "label": "Literal",
       "icon": "fa-align-left",
       "visibility": ["tooltip"],
       "system": "Translate literally word-by-word.",
       "user": "Provide a literal translation: {{nihongoWord}} (in: {{nihongoSentence}})"
   }
   ```
3. Re-import. The button appears wherever its visibility includes the current context. Setting `requiresDictionaryMatch: true` excludes it from the no-match selection tooltip.

### Adding Tooltip Content
Modify `buildSinglePage()` (word) or `populateKanjiTooltip()` (kanji) in kanji-tooltip.js. Add CSS under `.nihongo-tooltip` scope.

---

## 7. CSS Architecture

- **Feature toggles via parent classes on `#chat`** — no re-processing needed
- **CSS custom properties** — `--nihongo-font-size`, `--nihongo-furigana-scale`
- **Known kanji highlighting** uses `color-mix(in srgb, currentColor 45%, #4caf50)` to respect different message text colors
- **Tooltip** is `position: fixed` on `document.body` — avoids scroll clipping
- **Kana word styling** scoped under `.nihongo-kana-tooltips` class

---

## 8. Development & Debugging

### Setup
1. Clone/install the extension into `public/scripts/extensions/third-party/`
2. Extension auto-loads when ST starts — all dependencies are bundled, no build steps needed

**For development:** Build scripts in `scripts/` can rebuild data files from source (requires Node.js).

### Debugging Tips
- Console: `[NihongoHelper]` prefix on all logs
- DOM: `.nihongo-word[data-match-id]` → inspect stored matches
- Tooltip: pause in DevTools before it hides, or temporarily increase `HIDE_DELAY`
- Token matching: add `console.debug` in `buildMatchMap` / `greedySpans` for specific surfaces

---

## 9. Roadmap & Planned Architecture

> See [`ROADMAP.md`](ROADMAP.md) for full feature designs, rationale, and phased plans.

### Implemented Architectural Expansions

**Word Frequency Layer** — `data/frequency.json` with N-list support (currently JPDB, ~477K entries). Composite score function with configurable weights. Feeds into tooltip badges (percentage + tier coloring) and dict search result sorting. See `src/frequency.js`.

**Word Tracking Database** — `user/files/nihongo-tracking.json` via ST files endpoint. Sliding confidence model with compact (auto-tracked) and full (user-interacted) entry tiers. Nudge buttons in tooltip (Easy/Got it/Meh/Hard/Anki/Reset) with confidence bar display. See `src/tracking.js`.

**Side Panel Infrastructure** — Shared tabbed panel (`src/side-panel.js`) hosting Dictionary Search and Language Assistant Chat tabs. Left/right positioning, keyboard shortcuts, lazy tab building.

**v2 Prompt Architecture** — Stable cacheable system prompt + action instructions at depth. Full prompt stored per message for accurate multi-turn history. Configurable history modes (remove/deduplicate/keep_last_n).

**v3 Data-Driven Action Registry** — Tutor presets now own the action button registry (label / icon / visibility / system / user prompts). `src/side-chat-actions.js` validates each entry and guarantees a `custom` action fallback so free-form input always works. Tooltip and selection-tooltip rendering consume the registry directly.

**Tutor Preset Import / Export** — Settings-panel buttons next to the preset dropdown for downloading the active preset as JSON and importing user presets via file picker. Imported presets are stored under `user/files/nihongo-preset-<slug>.json` and indexed in `extension_settings.nihongo_helper.userPresets` (no directory listing required).

### Planned Architectural Expansions

**Prompt Preset Authoring** — In-app editor for tweaking presets without leaving SillyTavern (current Import/Export covers the round-trip; an inline editor is still future work).

**Chat Session Persistence** — Save/restore chat sessions via files endpoint (currently in-memory only).

**Anki Export** — Export tracked words with context sentences to Anki-compatible format.

**Adaptive Furigana Visibility** — Graduated algorithm using word confidence + frequency to determine per-word furigana visibility (currently binary known-kanji-based only).

**Auto Word Tracking** — Automatic `seenCount` increments during message processing for primary matches; track user-written words on send.

### Storage Tiers (Implemented)

| Tier | Store | Content | Save Frequency |
|------|-------|---------|---------------|
| 1 | extension_settings | User prefs, known kanji, panel settings | On change (debounced) |
| 2 | Files endpoint JSON | Word tracking DB (`nihongo-tracking.json`) | Every 30s / on unload |

Each planned feature builds on existing architecture: tokenizer → linguistic analysis, tooltip → UI surface, settings → user control, tracking → confidence data, macros → LLM feedback loop.
