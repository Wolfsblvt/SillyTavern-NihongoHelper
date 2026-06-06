# Feature Roadmap & Design Notes

> Detailed context, reasoning, and phased plans for all planned features.
> This is the "institutional memory" preserving brainstorming and design decisions.
> Future sessions should reference this to understand intent and approach.

---

## 1. Word Frequency Data

### Problem
JMdict's "common" flag is binary and on ~50% of entries — useless for difficulty distinction. Numerical rank (1–50,000+) is far more actionable.

### Idea
Import word frequency lists (same sources Yomitan uses) and display rank badges in tooltips.

### Why Multiple Lists
Different corpora reflect different language use:
- **JPDB** — modern media (anime, VN, LN). Most relevant for fiction/chat.
- **Innocent Corpus** — 5000+ novels. Literary Japanese.
- **Netflix/Anime** — spoken conversational Japanese. Very different from formal lists. A word like やばい might be rank 15,000 in newspapers but rank 200 in anime.
- **BCCWJ** — academic/formal/news.

For a learner in chat/RP context, anime/media frequency is often more relevant than newspaper frequency.

### Architecture: Build for N Lists from Day One
Even starting with one list, the data model supports N sources to avoid refactoring:
```javascript
// Per-word frequency data
{ "食べる": { jpdb: 342, netflix: 156, innocent: 891 } }

// Normalized composite (computed, not stored)
// With one list, just returns that value. With multiple, applies user weights.
function getCompositeFrequency(word) { /* weighted average */ }
```

All downstream features (furigana visibility, sorting, difficulty) use the composite score. Raw per-list values shown as individual badges in tooltip.

### Data Sources
Frequency lists available in Yomitan format (JSON: `[word, reading, rank]`). Build script `build-frequency.cjs` processes them into `data/frequency.json`.

### Display
Colored pills in tooltip: Top 1K (bright) → 1K-5K (medium) → 5K-15K (subtle) → 15K+ (faded/none).

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 1a | ✅ | Frequency data pipeline (build script, N-list format, composite score function) | Nothing |
| 1b | ✅ | Import first list (JPDB — ~477K entries) | 1a |
| 1c | ✅ | Display frequency badges in word tooltip (percentage + tier coloring + rank) | 1b |
| 1d | 🔲 | Add Netflix/Anime as second list | 1a |
| 1e | 🔲 | User settings: which lists to display, weights for composite score | 1c, 1d |
| 1f | 🔲 | Color-coding words in chat by frequency tier | 1c |

---

## 2. Language Assistant Side Chat

### Problem
User encounters Japanese they want help with during an ongoing LLM conversation, RP, or co-writing session. It may be the model's output, selected text, or the user's own draft. Options like breaking RP to ask the main chat or opening a separate tool both lose context and momentum.

### Idea
Slide-out side panel with a dedicated language assistant. Runs separate LLM calls. Has full context: the word, sentence, user's known kanji, furigana state.

### Why This Matters
Tooltips = passive lookup (readings, definitions, kanji data, deinflection). Side chat = active contextual help: which meaning fits, why the grammar/form is used, what tone or implication it has, how to reply, and how to phrase the user's own Japanese naturally. Together they cover the full "I need help with this Japanese right now" spectrum without leaving the app.

### Interaction Model
**Triggers:** Preset-defined tooltip buttons (for example Explain, Grammar, Nuance, Reply Help), selection fallback buttons, kanji/word tooltip context, and manual input in the panel.

**Auto-injected context per call:**
- Word/phrase in question + the sentence/paragraph it's in
- Preset-defined action chosen (for example explain, reply_help, naturalize, slang)
- User's known and learning kanji (so explanations match level and can mention active study targets when relevant)
- Whether furigana was shown (indicates reading unfamiliarity)

**Panel:** Slide-out right side, persists while user reads, supports follow-up messages (mini-chat), dismissible/collapsible.

### ST Integration
Uses `ConnectionManagerRequestService` and connection profiles for parallel LLM calls. Optionally configurable separate model/connection preset (cheap fast model for explanations, premium for RP).

### Prompt Architecture
Per-action specialized system prompts. Vague prompts → mediocre results. Each action type gets a carefully crafted template with context slots.

### Persistence (Phased)
1. Ephemeral (clears on close)
2. Per-session (follow-ups work within session)
3. Saved per-message (re-openable later)
4. Cross-reference (past insights inform future queries)

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 2a | ✅ | Infrastructure: side panel UI (tabbed, left/right), LLM call wrapper | Nothing |
| 2b | ✅ | Tooltip buttons: "Explain", "Translate", "Alternatives", "Grammar" → panel | 2a |
| 2c | ✅ | Structured prompts with full context injection (v2 preset system) | 2b |
| 2d | ✅ | Follow-up messages within same panel session (multi-turn) | 2c |
| 2e | ✅ | Configurable model/connection via Connection Manager profiles | 2a |
| 2f | 🔲 | Persistent conversations saved per-message | 2d, Storage (#16) |
| 2g | 🔲 | Re-access past side conversations | 2f |

---

## 3. Writing Feedback / Grammar Check

> **Status: 🧪 Implemented (first vertical slice).** Shipped as a shared feedback engine with two entry points (sent-message feedback + draft review) and an opt-in automatic mode. The tooltips already cover mechanical lookup; Writing Feedback covers higher-order quality: correctness, naturalness, register, meaning, and whether a reply fits the conversation.

### Problem
When writing Japanese, learners make mistakes they don't notice. Existing tools (fixmyjapanese.com, Grammarly for Japanese) are paid, require leaving the app, and lack conversation context.

### Design as built

**One engine, two entry points.** A single analysis engine (`feedback-engine.js`) builds prompts, calls the model, parses/validates the structured result, and resolves anchors. Two surfaces use it:

1. **Feedback on a sent message** — a per-message action button (`feedback-messages.js`) analyses a user message and attaches a collapsible card directly beneath it. Result persists in `message.extra.nihongoFeedback` (extension-owned metadata → never enters the main prompt), survives reload, goes **stale** on edit, and is removed on delete.
2. **Draft review** — a "Review Japanese" composer button (`feedback-draft.js`) opens a blocking modal that reviews the unsent draft, shows the same view plus an editable working copy, and applies a revision back to the composer. Never sends automatically.

**Automatic mode** *(opt-in)* — `Off` / `Japanese messages only`. Runs after a user message renders, gated by a cheap local Japanese-content heuristic, deduped by source-text hash, detached so it never blocks main generation.

### Why a separate call (not the main LLM)
- Doesn't pollute RP with meta-commentary (feedback is never part of the character prompt).
- User controls when they get feedback (explicit button), or opts into automatic mode.
- Reuses the side-tutor connection profile (no separate model selector); shares the low-level `requestCompletion` wrapper.
- Strict, versioned, structured output the extension parses and renders.

### Structured contract
Versioned JSON: `{ version, summary, revisedText|null, strengths[], issues[] }`. Each issue has `category`, `severity` (info/minor/major/critical), `confidence` (low/medium/high), `quote`, `occurrence`, `sentence?`, `explanation`, `replacement?`, `alternatives?`. The extension owns the contract and the category/severity tables (assembled from registries in `feedback-schema.js`); tutor presets only influence *style* via an optional `feedback` field. Parsing is defensive (fence-stripping, one trailing-comma repair, length/type clamping, unknown categories → generic fallback). Anchors are **application-computed** from the quote + occurrence, never trusted from the model.

### Categories
grammar, particle, conjugation, word_choice, naturalness, meaning, register, context, orthography, punctuation (+ generic `other` fallback).

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|------------|
| 3a | ✅ | Draft-review entry point (composer button + modal) | #2a (panel infra) |
| 3a′ | ✅ | Sent-message entry point (message action button + attached card) | #2a |
| 3b | ✅ | Versioned structured output parsing, validation, and rendering | 3a |
| 3c | ✅ | Conversation-context injection (configurable count, role-ordered, excludes hidden) | 3b |
| 3d | � | "Apply fix" — full revised text + single-issue apply in the draft modal (safe-anchor gated). Inline composer underlines still deferred. | 3b |
| 3e | ✅ | Sensitivity levels + learner-level (known/learning kanji) prompting | #7 (tracking) |
| 3f | ✅ | Automatic feedback mode (Japanese-only), persistence, staleness, concurrency/chat-switch safety | 3a′, 3b |
| 3g | 🔲 | Inline composer highlights / continuous review while typing | 3d |
| 3h | 🔲 | Mistake analytics + Anki suggestions from recurring issues | tracking |

---

## 4. Dictionary Search UI

### Problem
User wants to look up a word they're thinking of (know English meaning, want kanji form). Currently must open Jisho in separate tab.

### Idea
Built-in search box. Type English, kana, or kanji → instant results from local JMdict. Click to copy/insert.

### Why Local-First
We already have 22K+ entries in memory. Local search is instant, offline, no rate limits, consistent with our tooltip data. Jisho becomes a fallback for rare words or example sentences, not primary.

### Search Capabilities
- By English gloss ("to eat" → 食べる, 食う, ...)
- By kana reading ("たべる" → 食べる)
- By kanji form ("食" → all words containing 食)
- Partial matching ("eat" → "to eat", "eating", etc.)

### Result Actions
- 📋 Copy to clipboard
- ⬇️ Insert into chat input at cursor
- 🔍 Open in full tooltip view
- 🔗 "Open on Jisho" for more detail / example sentences

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|------------|
| 4a | ✅ | Search index over local JMdict (Fuse.js, English + kana + kanji) | Nothing |
| 4b | ✅ | Search UI (side panel tab with debounced input + result cards) | 4a |
| 4c | ✅ | Result actions: copy, insert into input, open in tooltip, romaji support | 4b |
| 4d | 🔲 | Jisho API fallback for extended results / example sentences | 4b |
| 4e | 🔲 | Integration into tooltip: "Search Jisho" button opens results in-app | 4d |

---

## 5. Anki Integration & Export

### Problem
Reading exposes vocabulary but without active recall, retention is low. Manual Anki card creation is tedious. We have LLMs available to auto-enhance cards.

### Idea
Multiple export paths: manual mark → batch export, auto-suggested cards from tracking data, LLM-enhanced fields.

### Card Content
**Baseline (our data only):** Front: kanji word. Hint: furigana. Back: reading, meanings, POS. Context: the chat sentence. Tags: JLPT, frequency, date.

**LLM-enhanced:** Simpler example sentence, mnemonic, related words, usage notes, similar-word distinction.

**On images:** Likely too spoiler-y (showing meaning defeats recall). Skip unless compelling non-spoiler use case.

### Export Methods
- **CSV** (universal, manual import, always works)
- **AnkiConnect** (localhost:8765 API, one-click add, requires Anki desktop + plugin)
- Support both. CSV as baseline, AnkiConnect as optional when detected.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|------------|
| 5a | 🔲 | "Save for Anki" button on word tooltip, stores word + context to queue | Nothing |
| 5b | 🔲 | Export queue UI (review saved words, remove unwanted) | 5a |
| 5c | 🔲 | CSV export (Anki-compatible format) | 5b |
| 5d | 🔲 | AnkiConnect detection + one-click add | 5a |
| 5e | 🔲 | LLM-enhanced card fields (mnemonic, example sentence) | 5b, #2a (LLM infra) |
| 5f | 🔲 | Auto-suggested cards based on tracking data | #7 (tracking) |

---

## 6. Adaptive Furigana Visibility

### Problem
Binary "hide for known kanji" is too crude. Known kanji ≠ known word (user might know 食 and 物 separately but not 食べ物 as compound). Extremely common words don't need furigana even without explicit "known" mark.

### Idea
Deterministic algorithm (no LLM, must be instant) decides per-word:
```
if wordLevel >= KNOWN → hide
if frequency < HIGH_THRESHOLD and kanjiKnown → hide
if frequency < MED_THRESHOLD or wordLevel >= RECOGNIZED → hover-only
else → always show
```

### User Control
Single slider: "Furigana visibility" (show more ↔ show less). Shifts frequency thresholds intuitively.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|------------|
| 6a | 🔲 | Replace binary check with graduated algorithm | #1, #7 |
| 6b | 🔲 | Visibility threshold slider setting | 6a |
| 6c | 🔲 | Per-word override (force show/hide on specific words) | 6a, #7 |

---

## 7. Granular Word & Kanji Tracking

### Problem
Only kanji tracked (binary known/unknown). No word-level tracking. Can't determine if user knows a word, how often they've seen it, whether they use it.

### Idea
Comprehensive word-level tracking: sliding confidence score, encounter history, timestamps, intuitive nudge buttons. This is the **foundation** for #5, #6, adaptive difficulty, and LLM feedback loop.

### Design Philosophy: Sliding Confidence, Not Rigid Levels

The user should NOT make conscious decisions like "is this word Recognized or Known?" That puts cognitive load on the learner and breaks reading flow. Instead, interactions are **intuitive nudges** — quick gut-reaction clicks that shift a confidence score:

- "I know this, easy" → strong positive nudge
- "Got it, recognized" → medium positive nudge
- "Meh, should've known" → small negative nudge
- "Hard, never heard of it" → strong negative nudge

The confidence score is a number that accumulates nudges over time. Five "never heard" clicks won't be overridden by one "got it" — the history matters. Crucially, a single positive click does not rocket a word to "mastered" status. Confidence builds gradually through repeated positive signals.

The system derives decision levels (for furigana visibility, difficulty assessment, etc.) from the score via thresholds, but the user never sees or sets levels directly.

### Data Model
```javascript
// Full entry (user has interacted OR auto-tracked)
{
  confidence: 0.65,     // 0.0 = completely unknown, 1.0 = mastered. Nudged by interactions.
  seenCount: 12,        // times appeared in LLM output
  usedCount: 3,         // times user wrote it (strong familiarity signal)
  firstSeen: "2024-03-15T10:30:00Z",
  lastSeen: "2024-04-01T14:22:00Z",
  lastUsed: "2024-03-28T09:15:00Z",
  lastInteraction: "2024-04-01T14:22:00Z",  // last time user clicked a button
  flags: ["anki-queued"]  // user-set flags: "anki-queued", "never-show"
}

// Compact entry (auto-tracked only, no user interaction yet)
{ s: 5, l: "2024-04-01" }  // s=seenCount, l=lastSeen (date only for compact)
```

### Confidence Score System

**Score range:** 0.0 (unknown) to 1.0 (mastered)

**Nudge values (approximate, tunable):**
| Action | Nudge | Rationale |
|--------|-------|-----------|
| Auto: first encounter | → set 0.05 | Bare minimum — "you've seen it" |
| Auto: seen again | +0.01 (diminishing) | Passive exposure builds slowly |
| Auto: used by user | +0.05 | Writing it is a strong signal |
| Button: "Easy, I know this" | +0.20 | Strong positive confirmation |
| Button: "Got it" | +0.10 | Medium positive |
| Button: "Should've known" | -0.05 | Small negative — doesn't destroy progress |
| Button: "Never heard of it" | -0.15 | Strong negative |

**Diminishing returns on passive exposure:** Each subsequent `seenCount` increment contributes less. Formula: `nudge = 0.01 * (1 / (1 + seenCount/20))`. A word seen 100 times passively might reach ~0.3 confidence — enough to be "seen/familiar" but not "known" without active confirmation.

**Clamping:** Score always stays in [0, 1]. Nudges are additive but clamped.

**Derived levels (for decision-making, not shown to user):**
| Score Range | Derived Level | Used For |
|-------------|---------------|----------|
| 0.0 – 0.1 | Unknown | Always show furigana, suggest for learning |
| 0.1 – 0.3 | Seen | Still show furigana, track encounters |
| 0.3 – 0.6 | Familiar | Hover-only furigana, don't suggest as "new" |
| 0.6 – 0.85 | Known | Hide furigana, count as vocabulary |
| 0.85 – 1.0 | Mastered | Fully hidden, can be used in LLM difficulty prompts |

These thresholds are configurable and feed into #6 (adaptive furigana).

### The Strictness Problem
Tooltips show all interpretations (generous). Tracking must be strict about WHAT counts.

`行きます` in text → track `行く` (dictionary form, primary match). Do NOT track `行き` (different word) or `増す` (unrelated parse of ます).

**Rule:** Track only the primary match from the token matcher — the longest greedy span's best dictionary form. Not sub-matches, not alternatives.

### Auto vs Explicit Tracking
- **Auto (silent):** seenCount increment, firstSeen/lastSeen, initial confidence seed, usedCount on user messages
- **Explicit (user clicks button):** Confidence nudges (+/-), flags, lastInteraction timestamp

### Tooltip Quick-Actions
Buttons shown on word tooltip (gut-reaction, minimal cognitive load):
- ✓ **Easy** — "I know this well" → strong positive nudge (+0.20)
- 👍 **Got it** — "Recognized, understood" → medium positive nudge (+0.10)
- 😕 **Meh** — "Should've known, didn't quite" → small negative nudge (-0.05)
- ❌ **Hard** — "Never heard of it" → strong negative nudge (-0.15)
- 📎 **Anki** — Queue for export (adds flag, doesn't affect confidence)

The button set is inspired by Anki's answer buttons but without the SRS scheduling complexity. The user just clicks their gut feeling and moves on.

### Scale & Storage
See [Storage Strategy](#16-storage-strategy). Thousands of words over time. Compact format for auto-tracked (no interaction), full format once user engages or score reaches threshold.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 7a | ✅ | Data model + storage infrastructure (files endpoint, tiered entries) | Storage (#16) |
| 7b | 🔲 | Auto-track seenCount for primary matches during processing | 7a |
| 7c | ✅ | Tooltip nudge buttons (Easy/Got it/Meh/Hard/Anki/Reset) + confidence bar | 7a |
| 7d | 🔲 | Track user-written words (tokenize input on send) | 7a |
| 7e | ✅ | Confidence nudge logic + derived levels + undo support | 7a, 7c |
| 7f | 🔲 | Migrate kanji known state to new format | 7a |
| 7g | 🔲 | Expose tracking data to LLM prompts (macro/context) | 7e |

---

## 8. Configurable Side Chat Actions ✅

### Problem
Side-chat action buttons (Explain, Translate, Grammar, Alternatives) used to be hard-coded. Adding or modifying actions required code changes, which blocked experimentation, custom tutors, and user-contributed workflows.

### Solution (shipped)
The action registry now lives in the tutor preset JSON. Each preset declares its own actions; the extension consumes them as data via `src/side-chat-actions.js`. No code changes needed to add an action or build a specialized tutor.

Bundled presets currently cover four intended modes:
- **Default Tutor** — balanced contextual help for meaning, grammar, nuance, kanji, replies, and rewrites.
- **Strict Tutor** — correction, grammar precision, conjugation, mistake analysis, naturalness, and tiny drills.
- **Immersion Companion** — quick flow-preserving help for understanding, intent, tone, Japanese paraphrase, and reply ideas.
- **Anime Geek Tutor** — anime/media/RP dialogue, slang, character voice, tropey phrasing, and real-life naturalness checks.

### Action Schema (preset JSON, v3)
| Field | Purpose |
|-------|---------|
| _key_ | Action ID is the object key (e.g. `actions.explain`). Stable; used for tracking, history, dedup. |
| `label` | Button text. Falls back to the id if missing. |
| `description` | User-facing metadata used as the action button tooltip and preset/action documentation. |
| `icon` | FontAwesome class (no `fa-solid` prefix). Falls back to a default icon. |
| `visibility` | Array of contexts: `tooltip` (word tooltip), `selection` (selection-fallback tooltip), `manual` (free-form input). Unknown values dropped. |
| `requiresDictionaryMatch` | If true, the action is excluded from contexts without a JMdict match. |
| `system` | System prompt at depth (macro-aware). |
| `user` | User prompt template (macro-aware). |

### Validation Rules (in `buildActionRegistry`)
- Invalid id → skip with console warning.
- Missing label → fallback to id.
- Missing icon → default icon.
- Missing **both** system and user prompts → skip (nothing to send).
- Unknown visibility value → silently dropped from the array.
- Empty/missing visibility → defaults to `[tooltip, selection]` (or `[manual]` for `custom`).
- No valid actions in preset → bundled default's `custom` action is injected as a fallback so free-form input always works.
- Duplicate ids → first wins, subsequent ones logged.

### Constraints
- No arbitrary JavaScript in presets — only declarative fields and macro-substituted strings.
- Built-in action sets ship as bundled preset JSON files under `data/presets/`, fully overrideable by selecting or importing another preset.
- Preset JSON validates leniently: one bad action does not crash the extension.

### Why
Custom tutors (beginner-only, kanji-focused, JLPT N3 cram, etc.) and custom workflows (e.g. "explain like I'm five", "Japanese-only paraphrase") become user-editable. The same mechanism enables community-shared presets.

### Import / Export
Settings panel exposes Import / Export / Delete buttons next to the preset dropdown:
- **Export** serializes the active preset as `nihongo-preset-<id>.json` for download.
- **Import** picks a JSON file, validates the schema, slugifies the name, resolves id collisions (appends `-2`, `-3`, …), uploads it to `user/files/nihongo-preset-<slug>.json` via the standard files endpoint, and registers it in `extension_settings.nihongo_helper.userPresets` so it appears in the dropdown immediately.
- **Delete** (visible only for user presets) removes the file and index entry, falling back to the bundled default.

Bundled presets cannot be deleted. Discovery no longer relies on the missing `/api/files/list` endpoint — the user-preset index is kept in extension_settings.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 8a | ✅ | Action schema + validator (`src/side-chat-actions.js`) | #2c |
| 8b | ✅ | Refactor built-in actions into the default preset (v3 schema) | 8a |
| 8c | ✅ | Tooltip / selection rendering driven by `visibility` flags | 8b |
| 8d | ✅ | Preset import / export / delete UX (file picker + download) | 8c |
| 8e | ✅ | Searchable preset selector card (name + description) reused in settings + side chat | 8d |
| 8f | ✅ | Per-chat tutor binding (chain icon, `chat_metadata` storage) | 8e |
| 8g | 🔲 | Inline preset editor inside settings (rename / edit actions in-app) | 8d |

### Per-chat tutor binding (8f)

The settings panel hosts the user's **default tutor** ("My default tutor"). Any
ST chat that hasn't been explicitly pinned follows this default. Inside the
side chat, the same selector card carries an extra **chain button** that
binds the active tutor to the current ST chat — useful when a particular
character needs a stricter / more casual / domain-specific tutor than the
account-wide default. The binding is stored under
`chat_metadata[EXTENSION_KEY].chatPresetId` (standard SillyTavern extension
pattern, persists with the chat export) and resolved on every `CHAT_CHANGED`
event:

```
effective preset = chat_metadata[EXTENSION_KEY].chatPresetId
                || extension_settings.nihongo_helper.chatPresetId
                || 'default'
```

Picking a different tutor from the side-chat selector auto-pins it; clicking
the chain icon while pinned reverts the chat to the default (whose name is
surfaced in the icon's tooltip).

---

## 9. Lorebook & Prompt Framework for Character Chats

### Problem
Side chat covers reactive lookups, but the main RP itself drives the bulk of exposure. Today, a learner has no portable way to make any character chat "Japanese-learning aware" without manually editing each character card or jamming setup into the system prompt.

### Idea
Provide a core ST lorebook / world-info pack defining stable Japanese-learning behavior, plus macros that inject dynamic learner state. Lorebook for stable, user-editable prompt content (ST-native, scoped, swappable per chat). Macros / JS injection for runtime state.

### Division of Responsibility
| Concern | Mechanism |
|---------|-----------|
| Difficulty level, correction style, overexplanation rules, katakana/kanji practice modes | Lorebook entries (user-editable, ST-native) |
| Known kanji, learning kanji, known vocab, tracking summaries, current difficulty setting | Macros / JS injection |

### Trigger / Module Examples
- `[NihongoBeginner]` — simple grammar, frequent translations, slow pace.
- `[NihongoNoOverexplain]` — no romaji, no English crutches unless asked.
- `[NihongoKatakanaPractice]` — bias loanwords / foreign names into katakana drills.
- `[NihongoAdvancedTutor]` — keigo, idioms, register correction.

These are activation keys, not magic strings — the underlying entries remain plain user-editable lorebook text.

### Why Lorebook (not pure macros)
- ST-native: works with existing world-info UI, scoping, position, depth controls.
- User-editable without touching the extension.
- Composable: users mix-and-match modules per chat.
- Survives extension updates without prompt resets.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 9a | 🔲 | Ship base lorebook pack with module entries (Beginner / NoOverexplain / KatakanaPractice / AdvancedTutor) | Nothing |
| 9b | 🔲 | Macros for dynamic state: `{{knownKanji}}`, `{{learningKanji}}`, `{{knownVocabSummary}}`, `{{difficulty}}` | #7, #13 |
| 9c | 🔲 | One-click "install / update lorebook" action from settings | 9a |
| 9d | 🔲 | Per-chat toggle UI to enable individual modules | 9a |

---

## 10. Example Tutor / Chat Partner Characters

### Problem
The extension is currently validated mostly on tooltips and side chat. Real immersive use — a Japanese-speaking partner that adapts to learner level over a long chat — has no first-party reference implementation.

### Idea
Ship one or two example character cards (or prompt examples) that consume the lorebook framework (#9) and demonstrate end-to-end usage. Strictly examples, **not** core dependencies.

### Suggested Examples
- **Friendly chat partner** — casual register, encouraging, light corrections only when asked.
- **Stricter tutor / mentor** — explicit corrections, grammar tagging, register coaching.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 10a | 🔲 | Friendly partner example card + sample chat | #9 |
| 10b | 🔲 | Stricter tutor example card + sample chat | #9 |
| 10c | 🔲 | Documentation pointing at examples for first-time users | 10a, 10b |

---

## 11. Anki Import / Learning State Sync

### Problem
Learners with an existing Anki deck arrive with significant prior knowledge. Without importing it, the extension treats them as beginners and over-shows furigana, over-suggests known vocab, and starts tracking from zero.

### Idea
Import vocab/kanji and review state from Anki (CSV first, AnkiConnect later). Use the imported state to seed: tracking confidence, known/learning vocab status, known/learning kanji, adaptive furigana thresholds, and prompt macros.

### Scope
- **Sources:** Anki CSV export (baseline), AnkiConnect query (advanced/future).
- **Mapping:** Anki ease / interval → confidence seed; suspended → ignored; due-today / learning queue → tagged as learning kanji / learning vocab.
- **Conflict policy:** Imported state never destroys higher confidence already gained in-extension. Take the max.

### Why After Export
Export and tracking shape the data model; importing is much easier once the schema is proven and stable. Premature import would force schema churn.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 11a | 🔲 | CSV import: map fields → seed tracking + known/learning kanji | #5 (export schema), #7, #13 |
| 11b | 🔲 | Conflict resolution + dry-run preview | 11a |
| 11c | 🔲 | AnkiConnect sync: pull review state on demand | 11a |
| 11d | 🔲 | Periodic / on-open re-sync option | 11c |

---

## 12. Extended Interaction Tracking

### Problem
Current seen-tracking is the bare minimum and not yet correct (counts spans inconsistently, doesn't distinguish hover vs lookup vs explicit nudge). Before extending, the existing path needs a correctness refactor.

### Idea
After the refactor, expand per-word tracking to capture richer interaction signals that feed Anki suggestions, "vocab from this chat", and adaptive difficulty.

### Tracked Signals (extension of #7 data model)
| Field | Purpose |
|-------|---------|
| `hoverCount` | User hovered word but did not engage further. Weak signal. |
| `lookupCount` | User opened the full tooltip / dictionary view. Stronger signal. |
| `actionCounts` | Per-side-chat-action: `explain`, `translate`, `grammar`, etc. Reveals what the user actually struggles with. |
| `lastHoverAt` / `lastLookupAt` / `lastActionAt` | Recency for decay and suggestion ranking. |
| `contexts` | **Bounded** list (e.g. last 3) of `{ sentence, chatId, messageId, ts }`, captured only on hover / explain / Anki-queue. |

### Bounded Contexts
- Hard cap (e.g. 3 per word) — never store unlimited message history.
- Captured only on meaningful interaction, not on every passive seen.
- Used to populate Anki example sentences and "suggest vocab from this chat".

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 12a | 🔲 | Tracking correctness refactor (fix seenCount semantics, primary-match strictness) | #7 |
| 12b | 🔲 | Add `hoverCount` / `lookupCount` / `actionCounts` fields | 12a |
| 12c | 🔲 | Bounded `contexts` storage with capture rules | 12b |
| 12d | 🔲 | "Suggest vocab from this chat" UI consuming the data | 12c, #5 |

---

## 13. Kanji Learning Mode ✅

### Problem
Originally kanji were binary: known or unknown. Learners actively studying a small set ("the next 10 N3 kanji") had no way to tell the model "use these naturally" while still seeing furigana for safety.

### Solution (shipped)
A unified per-kanji state map replaces the legacy `knownKanji` set. Every kanji is one of three states:

| State | Furigana | Counted as known | Passed to prompt |
|-------|----------|------------------|------------------|
| Unknown | Always shown | No | No |
| Learning | Always shown (does NOT hide furigana) | No | **Yes** — via `{{learningKanji}}` |
| Known | May be hidden by `hideKnownFurigana` | Yes | Yes — via `{{knownKanji}}` |

`known` always supersedes `learning`. Demoting a known kanji back to `learning` clears `knownSince` but preserves `learningSince` history. Unknown clears the entry entirely.

### Storage
`extension_settings.nihongo_helper.kanjiState`:
```js
{
  "食": { state: "learning", learningSince: ISO, updatedAt: ISO },
  "見": { state: "known",    knownSince: ISO,    updatedAt: ISO,
          learningSince?: ISO  // preserved if it was learning before }
}
```

The legacy `knownKanji` array/object is automatically migrated on first load and the old key is removed.

### Macros
- `{{learningKanji}}` — comma-separated kanji list for prompt injection (encourage the model).
- `{{learningKanjiCount}}` — for prompt budgeting / status displays.
- Plus the existing `{{knownKanji}}` / `{{knownKanjiCount}}`, now sourced from the same unified state map.
- Side-chat namespaced equivalents: `{{nihongoLearningKanji}}` / `{{nihongoLearningKanjiCount}}`.

### UI
- Kanji Manager detail header: segmented Unknown / Learning / Known selector with active state highlighting.
- Kanji Manager filter: `Learning Only` joins `Known Only` / `Unknown Only`.
- Kanji Manager grid: tile gets `nihongo-km-tile-learning` (subtle blue tint) or `nihongo-km-tile-known` (subtle green tint).
- Kanji Manager detail body: `Learning since` / `Known since` rows (visible only when set).
- Kanji tooltip (standalone): full segmented selector replaces the binary "Mark Known" button.
- Word tooltip kanji blocks: compact icon-only segmented selector in the corner of each block.
- Chat highlighting: `nihongo-kanji-learning` adds a subtle dotted-underline tint (toggled by the same `highlightKnown` setting that governs known highlighting). `known` styling keeps its existing green tint.
- Stats chip: `0 learning` count chip alongside the `0 known` chip.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 13a | ✅ | Unified `kanjiState` data model; `src/kanji-state.js` with legacy migration | — |
| 13b | ✅ | Kanji Manager UI: tri-state selector + Learning filter + Learning timestamps + tile class | 13a |
| 13c | ✅ | Macros `{{learningKanji}}` / `{{learningKanjiCount}}` (global + side-chat namespaced) | 13a |
| 13d | ✅ | Furigana wiring: `nihongo-kanji-learning` class; `hideKnownFurigana` only checks `known`, never `learning` | 13a |
| 13e | 🔲 | Adaptive furigana that uses `learning` state to decide visibility (graduated show/hover/hide) | 13a, #6 |

---

## 14. Partial Furigana Suppression (Experimental)

### Problem
In a multi-kanji word, today's logic is all-or-nothing: show furigana for the whole word, or hide it. A learner who knows 食 but not 物 in 食べ物 still sees furigana over both (or none).

### Idea
Hide furigana on per-kanji segments the user knows, while keeping it on segments they don't.

### Why "Experimental"
Reading-to-kanji alignment is genuinely hard:
- **Compounds with okurigana** (食べ物) — partial kana, partial kanji.
- **Jukujikun** (今日 = きょう) — reading does not map to individual kanji at all.
- **Rendaku** (時々 = ときどき) — second kanji's reading mutates.
- **Ateji** (寿司 = すし) — phonetic-only assignment.

A naive split produces wrong, distracting furigana that's worse than the all-or-nothing baseline.

### Conservative Strategy
- Attempt per-kanji suppression **only** when alignment is unambiguous (e.g. each kanji has exactly one matching reading from the dictionary).
- On any ambiguity (jukujikun, rendaku, ateji, multiple kanji-reading candidates) → fall back to whole-word furigana.
- Ship behind a setting; off by default.

### Phases
| Phase | Status | Scope | Depends On |
|-------|--------|-------|-----------|
| 14a | 🔲 | Alignment detector with conservative confidence threshold | kuromoji reading data |
| 14b | 🔲 | Per-kanji suppression renderer; fall-back path for ambiguous cases | 14a, #6, #13 |
| 14c | 🔲 | Setting + opt-in telemetry for incorrect-alignment reports | 14b |

---

## 15. Implementation Order

Features interleaved by phase for maximum early value.

### Recommended Near-Term Order
Sprints 4+ follow this dependency-aware sequence:

1. **Tracking correctness refactor** (12a) — fix the foundation before extending it.
2. **Configurable side-chat action registry** (#8) — unblocks experimentation, no schema risk.
3. ~~**Kanji learning mode** (#13)~~ — ✅ shipped (data model + UI + macros + furigana class). 13e (adaptive furigana wiring) folds into #6.
4. **Extended interaction tracking** (12b–12c) — builds on (1).
5. **Adaptive furigana** (6a–6b, 13e) — consumes the now-shipped learning state plus (4).
6. **Anki export** (5a–5c) — locks down the schema before importing.
7. **Lorebook framework** (#9) — once macros from (3)/(4) exist.
8. **Example characters** (#10) — exercise (7) end-to-end.
9. **Anki import** (#11) — depends on stable export schema.
10. **Partial furigana experiments** (#14) — last; opt-in, ambiguity-prone.

### Sprints

| Sprint | Phase | Scope | Status |
|--------|-------|-------|--------|
| **1: Foundations** | 7a | Word tracking data model + storage infra | ✅ |
| | 1a | Frequency pipeline (build script, N-list format, composite score) | ✅ |
| | 4a | Search index over local JMdict (Fuse.js) | ✅ |
| **2: First Visible** | 1b | Import first frequency list (JPDB) | ✅ |
| | 1c | Frequency badges in tooltip | ✅ |
| | 4b | Search UI (side panel tab) | ✅ |
| | 7c | Tooltip nudge buttons (Easy/Got it/Meh/Hard/Anki/Reset) | ✅ |
| **3: Side Chat MVP** | 2a | Side panel UI + LLM call wrapper | ✅ |
| | 2b | Tooltip buttons → preset-defined side-chat actions | ✅ |
| | 2c | Structured prompts with full context (v2 presets) | ✅ |
| | 4c | Search result actions (copy, insert, tooltip) | ✅ |
| **4: Tracking & Action Registry** | 12a | Tracking correctness refactor (seenCount semantics, primary-match strictness) | 🔲 |
| | 8a, 8b | Action schema + validator; refactor built-ins to default preset | ✅ |
| | 13a, 13b, 13c, 13d | Kanji learning mode: data model, manager UI, macros, furigana class | ✅ |
| | 8c | Visibility-driven button rendering (tooltip/selection/manual) | ✅ |
| | 8d | Preset import / export / delete UX | ✅ |
| **5: Extended Tracking & Adaptive Furigana** | 12b, 12c | hover/lookup/action counts + bounded contexts | 🔲 |
| | 6a, 6b | Graduated furigana visibility + threshold slider | 🔲 |
| | 13e | Wire learning kanji into adaptive furigana visibility | 🔲 |
| | 7d | Track user-written words (tokenize on send) | 🔲 |
| **6: Export, Lorebook, Examples** | 5a, 5b, 5c | "Save for Anki" + queue UI + CSV export | 🔲 |
| | 9a, 9b | Lorebook pack + dynamic-state macros | 🔲 |
| | 10a | Friendly partner example card | 🔲 |
| | 9c, 9d | Lorebook install action + per-chat module toggles | 🔲 |
| **7: Import & Experiments** | 11a, 11b | Anki CSV import + dry-run preview | 🔲 |
| | 10b, 10c | Stricter tutor example card + first-time docs | 🔲 |
| | 14a, 14b | Partial furigana suppression (experimental) + fall-back | 🔲 |
| | 11c, 11d | AnkiConnect sync + periodic resync | 🔲 |
| | 1d, 1e | Additional frequency lists + weights | 🔲 |
| | 3a–3c, 3e, 3f | Writing Feedback: engine, sent-message + draft entry points, structured display, context, sensitivity, auto mode | ✅ |
| | 3d | Writing Feedback: apply revised / single fix (inline underlines deferred) | 🟡 |
| | 3g, 3h | Writing Feedback: inline highlights, mistake analytics / Anki suggestions | 🔲 |
| | 14c | Partial furigana setting + opt-in telemetry | 🔲 |

This order ensures: foundational data layers first → visible features quickly → LLM features once panel exists → tracking correctness before extension → schema-stable export before import → experimental work last.

---

## 16. Storage Strategy ✅

### The Problem
Word tracking data will grow large (thousands of entries over months). SillyTavern's `extension_settings` is JSON-serialized on every `saveSettingsDebounced()` call. Bloating it with tracking data would slow all settings saves.

### Solution: Tiered Storage (Implemented)

**Tier 1: extension_settings (small, critical data)**
- User preferences/settings (current approach, unchanged)
- Unified kanji state map for known/learning kanji, small and bounded. (existing, small — ~3000 entries max)

**Tier 2: Separate file via ST files endpoint (large, non-critical data)**
- Full word tracking database → `user/files/nihongo-tracking.json`
- Side chat history (planned — not yet persisted)
- Anki export queue (planned)

ST's files endpoint (`/api/files/upload`) allows uploading arbitrary files to the user's data directory. They can be downloaded directly via fetch. The extension:
1. Maintains an in-memory tracking database (`Map<string, WordEntry | CompactEntry>`)
2. Debounced saves every 30s via the files endpoint (separate from settings save cycle)
3. Loads the file on extension init (graceful if missing)
4. Saves on `beforeunload` / `visibilitychange` for safety

**File path:** `user/files/nihongo-tracking.json`

**Benefits:**
- Settings saves remain fast (small payload)
- Tracking data saves less frequent (every 30s or on visibility change)
- No size concern — JSON file can grow freely
- Backup/restore is just a file copy

### Implementation Notes
- `saveTrackingNow()` with 30s debounce timer (`SAVE_INTERVAL_MS`)
- Fire-and-forget upload (base64-encoded JSON via `/api/files/upload`)
- Verify endpoint check on load avoids 404 console noise on first run
- Dirty flag prevents unnecessary saves; retry on failure

---

## 17. Technical Notes

### Frequency Data Format
```javascript
// data/frequency.json
{
  v: 1,
  lists: {
    "jpdb": { name: "JPDB", description: "Modern media frequency", count: 50000 },
    "netflix": { name: "Netflix/Anime", description: "Spoken conversational", count: 30000 }
  },
  words: {
    "食べる": { jpdb: 342, netflix: 156 },
    "行く": { jpdb: 45, netflix: 23 },
    // ...
  }
}
```

### Side Chat Prompt Architecture (v2)

Presets use a two-layer system: stable system prompt + per-action instructions at depth.

```
messages[0] (system — STABLE, cacheable):
  = preset.systemPrompt template (composes {{nihongoPersonality}} + {{nihongoRules}})
  Identical across all turns in a session.

messages[1..N-2] (history):
  Interleaved user/assistant, with user msgs using stored `prompt` field.
  Old action instructions stripped/deduped per chatHistoryMode setting.

messages[N-1] (system at depth — action instructions):
  = preset.actions[actionId].system (macro-substituted)

messages[N] (user):
  = preset.actions[actionId].user (macro-substituted with word, sentence, etc.)
```

Macros: `{{nihongoWord}}`, `{{nihongoSentence}}`, `{{nihongoKnownKanjiCount}}`, `{{nihongoPersonality}}`, `{{nihongoRules}}`, `{{nihongoUserMessage}}`.

### AnkiConnect API
```javascript
// Detection
fetch('http://localhost:8765', { method: 'POST', body: JSON.stringify({action:'version',version:6}) })

// Add note
{ action: 'addNote', version: 6, params: { note: {
  deckName: 'Japanese', modelName: 'Basic',
  fields: { Front: word, Back: meanings },
  tags: ['nihongo-helper', `jlpt-n${jlpt}`]
}}}
```

### Word Tracking Strictness Implementation
During message text processing, immediately after `analyzeTokens` returns greedy spans:
- For each span with `matches.length > 0`:
  - Take `matches[0]` (primary/best match)
  - Extract dictionary form (the matched word, not the surface)
  - Increment `seenCount` in tracking store
- Only track spans whose primary match is the full-span match (not sub-matches)
- Ignore single-kana particles and punctuation tokens

## 18. Unsorted ToDos
These ToDos will be listed and organized in the future.
- [ ] Add Tutor/preset selector into the side chat panel
- [ ] Bind tutors to chat-level and character level
- [ ] Add slash command support (get/select tutor, run tutor actions & more)
- [ ] Refactor settings, resorting and adding sub drawers
- [ ] Add Tutor edit/creation popup, with full support for action lists (including FA selector)
