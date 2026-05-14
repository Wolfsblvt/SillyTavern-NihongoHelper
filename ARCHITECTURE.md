# Architecture & Design Document

> Authoritative reference for the NihongoHelper project.
> Explains the **why** behind decisions, system architecture, data pipelines,
> algorithms, and extension patterns. Intended for both human developers and
> AI coding agents as a baseline for understanding and extending this project.

---

## 1. Vision & Philosophy

### What is NihongoHelper?

A **SillyTavern extension for learning Japanese through immersive chat**. Rather than treating language learning as a separate activity, it overlays linguistic information directly on the conversation — furigana, dictionary tooltips, kanji details, inflection analysis — so the user absorbs Japanese naturally while reading.

### Core Design Principles

1. **Passive Learning First** — Information on hover/glance, never forced. No interrupting popups or quizzes.
2. **Deterministic & Offline** — All analysis runs locally with bundled data. No network calls for core functionality.
3. **Non-Destructive** — Never modifies message data. Annotations are DOM overlays, original text preserved in `data-original`.
4. **Progressive Disclosure** — Furigana always visible → meanings on hover → all interpretations via pagination.
5. **Adaptive to Learner Level** — Known kanji tracking hides unneeded info. `{{knownKanji}}` macro feeds into LLM prompts for difficulty adaptation.
6. **SillyTavern-Native** — Uses ST's extension API, settings persistence, event hooks, UI conventions.

### Long-Term Goal

Build a complete Japanese immersion learning layer:
- Adapt LLM output difficulty to user's current level (via macros + system prompts)
- Instant in-context dictionary access for any word
- Track vocabulary exposure and known words over time
- Grammar pattern recognition and structured review
- Bridge passive reading into active recall (Anki export, session vocabulary)

**Key insight:** Roleplay chat provides unlimited, engaging, level-appropriate reading material. The LLM can be prompted to use specific kanji/grammar. NihongoHelper closes the loop by (a) showing what words mean in-context, and (b) telling the LLM what the user already knows.

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
├── kanji-manager.js    (popup UI, known tracking)
├── kanji-tooltip.js    (hover tooltip: kanji + word, positioning, pagination)
│   ├── meaning-provider.js, deinflect.js, token-matcher.js (getStoredMatches)
│   ├── furigana.js (reprocessMessagesWithKanji)
│   └── side-chat.js (triggerChatAction — from tooltip action buttons)
├── side-chat-prompts.js (preset system: JSON loader, discovery, active preset state)
│   └── data/presets/default.json (bundled default preset)
├── side-chat-llm.js    (LLM call wrapper, macro substitution)
│   └── side-chat-prompts.js (getSystemPrompt, getUserPrompt)
├── side-chat.js        (chat tab UI, sessions, streaming, messageFormatting)
│   └── side-chat-llm.js, side-chat-prompts.js
├── dict-search-ui.js   (side panel search tab, result cards)
│   └── dict-search.js  (3-phase search: direct → deinflect → Fuse)
│       ├── romaji.js    (romaji-to-hiragana conversion)
│       └── jmdict.js, deinflect.js, frequency.js
├── frequency.js        (word frequency ranks, sigmoid percent, tiers)
├── wand-menu.js        (extensions menu)
└── macros.js           ({{knownKanji}}, {{knownKanjiCount}})
```

---

## 3. Module Reference

### `index.js` — Entry Point

Called by ST via `manifest.json` hook `{ activate: "init" }`. Init order:
1. Settings (sync) → 2. Settings UI (async) → 3. Furigana system (async, registers hooks) → 4. Kanji Manager → 5. Prompt presets (async, discover + load) → 6. Side panel tabs (Search + Chat) → 7. Wand menu → 8. Inspect shortcut → 9. Selection lookup → 10. Macros → 11. Meaning provider (async, non-blocking)

**Why this order:** Settings first (everything reads them). Furigana hooks before any messages render. Presets before side chat (chat needs prompts). JMdict loads in background (3.5MB) — furigana works immediately, tooltips become available once loaded.

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

### `src/kanji-tooltip.js` — Tooltip System (~1200 lines)

Delegated hover detection → show/hide state machine (300ms show, 400ms hide) → paginated word tooltips OR compact kanji tooltips → smart positioning (right→left→below, constrained to viewport) → scroll navigation (Shift+Scroll anywhere, plain scroll on tab list only) → position adjustment (only upward, never back down to prevent jitter) → selection lookup (select text to look up) → inspect mode.

**Why delegated events:** Chat messages are dynamic. One listener on container works with all content, zero cleanup on message change.

### `src/kanji-manager.js` — Kanji Browser

Grid popup with 2998 kanji. Filter by JLPT/grade/known. Sort by freq/grade/JLPT/strokes. Known state persisted as `{ char: dateString }` in extension_settings.

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

`{{knownKanji}}` (comma-separated list) and `{{knownKanjiCount}}` for use in system prompts to adapt LLM difficulty.

### Language Assistant Side Chat

Four-module architecture for the side chat feature:

**`src/side-chat-prompts.js`** — Prompt Preset System. Presets are JSON files with:
- `personality` — shared personality/rules prepended to ALL action system prompts
- `actions` — per-action `{ system, user }` prompt templates
- Templates use namespaced `{{nihongoWord}}`, `{{nihongoSentence}}`, etc. macros

Bundled default preset at `data/presets/default.json`. User presets can be placed at `user/files/nihongo-presets/*.json` (auto-discovered). Active preset selected in settings, loaded at init.

Key API: `getSystemPrompt(actionId)` returns personality + action system prompt. `getUserPrompt(actionId)` returns user template. `initPresets(id)` discovers + loads. `CHAT_ACTIONS` array defines action metadata (id, label, icon).

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
- Word tooltips include 4 quick-action buttons: Explain, Translate, Alternatives, Grammar
- Buttons in `.nihongo-wt-chat-actions` div
- Click handler uses `hoveredTarget` element to find the containing `.mes_text` directly (not text search), then extracts context sentence from that specific message. This ensures correct context even for inflected forms.
- Reading is NOT passed to the LLM (dictionary reading may not match contextual reading — e.g., 文 as ぶん vs ふみ). The LLM determines reading from context.
- **Selection fallback:** When selecting Japanese text with no dictionary match, a minimal tooltip with just the word + chat action buttons is shown via `showMinimalSelectionTooltip()`. This ensures AI actions are always available.

**Settings** (`templates/settings.html`, `src/settings.js`):
- "Language Assistant" section with Connection Manager profile dropdown and tutor preset selector
- `chatProfileId` and `chatPresetId` persisted in extension_settings
- Profile list refreshed on connection profile events
- Preset list populated from `getPresetList()` (discovered presets)

### Side Chat — Prompt Building Flow

This section documents how the LLM messages array is constructed for every side chat request, and the known problems with the current approach.

#### Message Array Structure (Current)

Every request builds a flat messages array: `[system, ...history, user]`

```
┌─────────────────────────────────────────────────────────┐
│ messages[0]: system                                     │
│   = preset.personality + preset.actions[actionId].system│
│   (macro-substituted with CURRENT context)              │
├─────────────────────────────────────────────────────────┤
│ messages[1..N-1]: history                               │
│   = last 10 user/assistant messages from session        │
│   (raw display text from UI, NOT the original prompts)  │
├─────────────────────────────────────────────────────────┤
│ messages[N]: user                                       │
│   = preset.actions[actionId].user                       │
│   (macro-substituted with CURRENT context)              │
└─────────────────────────────────────────────────────────┘
```

#### Scenario Walk-throughs

**A. First action (Grammar on 書きます) — no history**
```
[system] personality + grammar rules (mentions 書きます via macros)
[user]   "Explain this grammar pattern: **Expression:** 書きます ..."
```
Works correctly — single turn, self-contained.

**B. Follow-up text ("Does kaku mean both write and draw?")**
```
[system] personality + custom rules ("answer the student's question directly")
[user]   "Grammar: 書きます"          ← history (UI display text!)
[asst]   "[grammar explanation]"       ← history
[user]   "Does kaku mean both write and draw?"  ← from {{nihongoUserMessage}}
```
Problem: system prompt CHANGED from grammar→custom. History user msg is the short display label `"Grammar: 書きます"`, not the full prompt that was actually sent. The LLM sees an inconsistent conversation.

**C. New action on different word (Explain on 食べる) — same session**
```
[system] personality + explain rules (now about explaining words)
[user]   "Grammar: 書きます"          ← history (UI display text)
[asst]   "[grammar explanation]"       ← history
[user]   "Does kaku mean both write and draw?"  ← history
[asst]   "[follow-up answer]"          ← history
[user]   "Explain: 食べる"             ← history (UI display text!)
[user]   "Explain this word: **Word:** 食べる ..."  ← current prompt
```
Problems: system prompt is now explain-rules (was grammar-rules for earlier turns). Two consecutive user messages (history display text + actual prompt). History entries from different topics/actions mixed under one system prompt.

#### Known Problems

1. **System prompt mutates per request.** Each action rebuilds personality+action system prompt. Prior history turns were generated under different system instructions. The LLM sees mixed signals.

2. **History contains UI display text, not actual prompts.** `formatActionMessage()` produces `"Grammar: 書きます"` for display. This string goes into history. But the LLM originally received a full template like `"Explain this grammar pattern: **Expression:** 書きます **Context:** ..."`. The short label is not meaningful to the LLM as conversation context.

3. **Consecutive user messages.** When a new action is triggered in an existing session, the action's display message (`"Explain: 食べる"`) is in history as a user message, immediately followed by the actual user prompt. Two user messages in a row confuse most models.

4. **Context macros are always from the CURRENT request.** The `{{nihongoWord}}` etc. in the system prompt reflect the latest action's context. But the system prompt also governs interpretation of older history turns that used different words/contexts.

5. **No prompt cache benefit.** The system prompt changes on every request (different action rules, different macro values). API-level prompt prefix caching (Anthropic, OpenAI) is defeated because the longest stable prefix is zero tokens.

#### Target Architecture (v2 Refactor)

The goal: **stable cacheable prefix, self-contained turns, action instructions at depth, configurable history handling.**

##### Preset Format v2

```json
{
    "v": 2,
    "name": "Default Tutor",
    "description": "A concise Japanese tutor for in-context word and grammar questions.",
    "personality": "You are a concise Japanese language tutor...",
    "rules": "- Be concise.\n- Match level to student ({{nihongoKnownKanjiCount}} kanji known).\n...",
    "systemPrompt": "{{nihongoDescription}}\n\n{{nihongoPersonality}}\n\n{{nihongoRules}}",
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

##### Required Implementation Changes

1. **Preset format v2** — Add `systemPrompt`, `description`, `rules` fields. Register preset fields as dynamic macros (`nihongoPersonality`, `nihongoDescription`, `nihongoRules`).
2. **`getSystemPrompt()` → split** — `getMainSystemPrompt()` (stable template) and `getActionInstructions(actionId)` (at depth).
3. **`ChatMessage` extended** — Add `prompt`, `instructions`, `actionId` fields.
4. **`buildMessages()` refactored** — Inserts system-at-depth before current user. Handles history system messages per setting mode.
5. **`buildHistoryForLLM()` refactored** — Reads `msg.prompt` instead of `msg.content` for user messages. Applies system message handling mode.
6. **UI rendering** — System bar elements, expand/collapse toggle, `[⋯]` button on user bubbles.
7. **New setting** — "Action instructions in history" dropdown + optional "keep last N" number input.
8. **Preset migration** — `loadPreset()` handles both v1 (legacy: personality prepended) and v2 (template-based). v1 presets auto-mapped: `systemPrompt = "{{nihongoPersonality}}"`, personality stays as-is.

---

## 4. Data Pipeline

### Kanji Data
- **Source:** davidluzgouveia/kanji-data (KANJIDIC2-derived)
- **Build:** `node scripts/build-kanji-data.cjs`
- **Output:** `data/kanji.json` (425KB, 2998 entries, tracked)
- Format: `{ k, s, g, f, jlpt, m, on, kun, i }`

### JMdict Dictionary
- **Source:** scriptin/jmdict-simplified (CC BY-SA 4.0)
- **Build:** `node scripts/build-jmdict.cjs --download`
- **Output:** `data/jmdict.json` (3.5MB, ~22.5K common entries, tracked)
- Format: `{ v, date, src, tags, words: [{ k?, r, c?, s: [{ p, g, m?, i?, f? }] }] }`
- Max 5 senses, 5 glosses per entry

### Word Frequency
- **Source:** JPDB frequency list (477K entries)
- **Build:** `node scripts/build-frequency.cjs`
- **Output:** `data/frequency.json` (~16MB, tracked)
- Format: `{ v, builtAt, lists: { key: { name, count } }, words: { word: { listKey: rank } } }`
- Multiple list support (currently JPDB only); composite scoring with configurable weights

### Tutor Presets
- **Bundled:** `data/presets/default.json` (tracked in git)
- **User presets:** `user/files/nihongo-presets/*.json` (auto-discovered via files endpoint)
- Format (v1): `{ v, name, description, personality, actions: { actionId: { system, user } } }`
- `personality` is prepended to every action's system prompt (shared tutor character)
- Action IDs: `explain`, `translate`, `alternatives`, `grammar`, `custom`
- Templates use `{{nihongoWord}}`, `{{nihongoSentence}}`, `{{nihongoKnownKanjiCount}}` etc.

### Kuromoji Tokenizer
- Pre-built browser UMD bundle + `.dat.gz` dictionaries in `lib/kuromoji/` (gitignored, ~18MB)
- **Why bundled:** ST extensions are client-side only. No server component possible. Kuromoji runs in-browser, deterministic, fast (<50ms/message).

---

## 5. Key Trade-offs

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Bundled kuromoji (~18MB) | Large download | Offline, deterministic, no server |
| Common-only JMdict (3.5MB) | Misses rare words | 95%+ conversation coverage |
| Single-step deinflection | Misses compound inflections | Simple, covers most cases |
| No `<rp>` tags | No ancient browser fallback | ST = modern Chromium; eliminates flash bug |
| Greedy longest-match | May occasionally group wrong | Pragmatic vs exponential combinatorics |
| No bundler/build step | No minification | ST serves extensions as-is; simplicity wins |
| HTML string concatenation | Not reactive/virtual DOM | Matches ST patterns; performant at this scale |
| `messageFormatting` in side chat | Couples to ST internals | Consistent rendering (markdown, regex, furigana hooks). One function gives all formatting for free. |
| Preset JSON files (not settings) | Requires file endpoint | Presets can be large, shareable, git-friendly. Settings used only for the active preset ID. |
| No reading in LLM context | LLM must infer reading | Dictionary reading often wrong for context (文=ぶん/ふみ). LLM does better with sentence context. |
| History = display text (current) | LLM sees lossy history | See "Prompt Building Flow" — planned fix: store full prompt alongside display text |
| System prompt per-action (current) | No prompt caching, mixed signals | See "Prompt Building Flow" — planned fix: stable personality + action-at-depth |

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
1. Copy `data/presets/default.json` to `user/files/nihongo-presets/my-preset.json`
2. Edit `personality` (shared tutor character) and per-action prompts
3. Use `{{nihongoWord}}`, `{{nihongoSentence}}`, `{{nihongoKnownKanjiCount}}` macros
4. Restart ST or re-open settings — preset auto-discovered and appears in dropdown

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
1. Place kuromoji files in `lib/kuromoji/` (UMD build + dict/*.dat.gz)
2. Run `node scripts/build-jmdict.cjs --download` and `node scripts/build-kanji-data.cjs`
3. Extension auto-loads when ST starts

### Debugging Tips
- Console: `[NihongoHelper]` prefix on all logs
- DOM: `.nihongo-word[data-match-id]` → inspect stored matches
- Tooltip: pause in DevTools before it hides, or temporarily increase `HIDE_DELAY`
- Token matching: add `console.debug` in `buildMatchMap` / `greedySpans` for specific surfaces

---

## 9. Roadmap & Planned Architecture

> See [`ROADMAP.md`](ROADMAP.md) for full feature designs, rationale, and phased plans.

### Planned Architectural Expansions

**Word Frequency Layer** — New `data/frequency.json` with N-list support (JPDB, Netflix/Anime, etc.). Composite score function with configurable weights. Feeds into tooltip badges, furigana visibility, and difficulty assessment.

**Word Tracking Database** — Separate storage file (via ST files endpoint) for word-level encounter/familiarity data. Tiered: compact auto-tracked entries + full entries for explicitly-marked words. Decoupled from extension_settings to avoid bloating settings saves.

**Prompt Preset Authoring** — UI for creating/editing presets within the extension (currently JSON-only via file system).

**Chat Session Persistence** — Save/restore chat sessions via files endpoint (currently in-memory only).

**Anki Export** — Export tracked words with context sentences to Anki-compatible format.

### Storage Tiers (Planned)

| Tier | Store | Content | Save Frequency |
|------|-------|---------|---------------|
| 1 | extension_settings | User prefs, known kanji, explicitly-marked words | On change (debounced) |
| 2 | Files endpoint JSON | Full tracking DB, side-chat history, Anki queue | Every 30s / on unload |

Each planned feature builds on existing architecture: tokenizer → linguistic analysis, tooltip → UI surface, settings → user control, macros → LLM feedback loop.
