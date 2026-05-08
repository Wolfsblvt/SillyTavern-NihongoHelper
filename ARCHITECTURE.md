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
├── furigana.js         (tokenization, DOM processing, event hooks)
│   ├── token-matcher.js  (multi-token matching, greedy spans, match store)
│   │   ├── meaning-provider.js → jmdict.js
│   │   └── deinflect.js
│   └── kanji-data.js
├── kanji-manager.js    (popup UI, known tracking)
├── kanji-tooltip.js    (hover tooltip: kanji + word, positioning, pagination)
│   ├── meaning-provider.js, deinflect.js, token-matcher.js (getStoredMatches)
│   └── furigana.js (reprocessMessagesWithKanji)
├── wand-menu.js        (extensions menu)
└── macros.js           ({{knownKanji}}, {{knownKanjiCount}})
```

---

## 3. Module Reference

### `index.js` — Entry Point

Called by ST via `manifest.json` hook `{ activate: "init" }`. Init order:
1. Settings (sync) → 2. Settings UI (async) → 3. Furigana system (async, registers hooks) → 4. Kanji Manager → 5. Wand menu → 6. Inspect shortcut → 7. Selection lookup → 8. Macros → 9. Meaning provider (async, non-blocking)

**Why this order:** Settings first (everything reads them). Furigana hooks before any messages render. JMdict loads in background (3.5MB) — furigana works immediately, tooltips become available once loaded.

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

### `src/macros.js` — ST Macros

`{{knownKanji}}` (comma-separated list) and `{{knownKanjiCount}}` for use in system prompts to adapt LLM difficulty.

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

**Side Panel UI** — New slide-out panel component for language assistant LLM interactions. Shares infrastructure between dictionary explanations, grammar check, and persistent conversations. Uses ST's parallel LLM call capabilities.

**Local Dictionary Search** — Search index over JMdict (English glosses + readings + kanji forms) for in-app word lookup without external dependencies.

### Storage Tiers (Planned)

| Tier | Store | Content | Save Frequency |
|------|-------|---------|---------------|
| 1 | extension_settings | User prefs, known kanji, explicitly-marked words | On change (debounced) |
| 2 | Files endpoint JSON | Full tracking DB, side-chat history, Anki queue | Every 30s / on unload |

Each planned feature builds on existing architecture: tokenizer → linguistic analysis, tooltip → UI surface, settings → user control, macros → LLM feedback loop.
