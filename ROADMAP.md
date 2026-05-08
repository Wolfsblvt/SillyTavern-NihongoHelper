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
| Phase | Scope | Depends On |
|-------|-------|-----------|
| 1a | Frequency data pipeline (build script, N-list format, composite score function) | Nothing |
| 1b | Import first list (JPDB or Innocent Corpus) | 1a |
| 1c | Display frequency badges in word tooltip | 1b |
| 1d | Add Netflix/Anime as second list | 1a |
| 1e | Settings: which lists to display, composite weights | 1c, 1d |
| 1f | Color-code words in chat by frequency tier | 1c |

---

## 2. Language Assistant Side Chat

### Problem
User encounters something they want to ask about. Options: break RP to ask (ruins immersion), open separate ChatGPT (loses context). Both bad.

### Idea
Slide-out side panel with a dedicated language assistant. Runs separate LLM calls. Has full context: the word, sentence, user's known kanji, furigana state.

### Why This Matters
Tooltips = passive (dictionary answer). Side chat = active (understanding, nuance, grammar breakdown). Together they cover the full "I don't understand this" spectrum without leaving the app.

### Interaction Model
**Triggers:** Tooltip buttons ("Explain", "Translate in context", "Alternatives/Synonyms"), kanji tooltip ("Explain kanji"), manual input in panel.

**Auto-injected context per call:**
- Word/phrase in question + the sentence/paragraph it's in
- Action chosen (explain / translate / alternatives / grammar)
- User's known kanji (so explanations match level)
- Whether furigana was shown (indicates reading unfamiliarity)

**Panel:** Slide-out right side, persists while user reads, supports follow-up messages (mini-chat), dismissible/collapsible.

### ST Integration
Uses `generateQuietPrompt` or direct generate API for parallel LLM calls. Optionally configurable separate model/connection preset (cheap fast model for explanations, premium for RP).

### Prompt Architecture
Per-action specialized system prompts. Vague prompts → mediocre results. Each action type gets a carefully crafted template with context slots.

### Persistence (Phased)
1. Ephemeral (clears on close)
2. Per-session (follow-ups work within session)
3. Saved per-message (re-openable later)
4. Cross-reference (past insights inform future queries)

### Phases
| Phase | Scope | Depends On |
|-------|-------|-----------|
| 2a | Side panel UI (slide-out, collapsible) + LLM call wrapper | Nothing |
| 2b | Tooltip buttons → fire call → show result in panel | 2a |
| 2c | Structured prompts with full context injection | 2b |
| 2d | Follow-up messages within panel session | 2c |
| 2e | Configurable model/connection for side-chat | 2a |
| 2f | Persistent conversations (saved per-message) | 2d, Storage |
| 2g | Re-access past side conversations | 2f |

---

## 3. Writing Feedback / Grammar Check

### Problem
When writing Japanese, learners make mistakes they don't notice. Existing tools (fixmyjapanese.com, Grammarly for Japanese) are paid, require leaving app, lack conversation context.

### Idea
Pre-send "Check Japanese" button. Separate LLM call analyzes user's input text, returns structured feedback:
```
がない → ではない
[Word Choice] "ではない" is needed in this context.

とだします → と示します
[Kanji] "示す" is the correct verb for "show".
```

### Why Separate Call (Not Main LLM)
- Doesn't pollute RP with meta-commentary
- User controls when they get feedback (explicit button)
- Can use cheaper/faster model
- Structured, predictable output
- Pre-send = can fix before sending (unlike post-hoc feedback in reply)

Could optionally support in-reply feedback too (main LLM includes correction in structured block), but the pre-send check is primary.

### Categories
Grammar, Word Choice, Kanji, Politeness/Register, Naturalness, Spelling/Typo.

### Shares Infrastructure with #2
Same side panel, same LLM call wrapper. "Check Japanese" is a specialized action with a correction-focused prompt. Follow-up questions ("why is ではない better?") use same conversation continuation.

### Advanced: Interactive Correction
"Apply fix" buttons that auto-replace incorrect segments in the input field. Turns it from informational into Grammarly-like editor.

### Phases
| Phase | Scope | Depends On |
|-------|-------|-----------|
| 3a | "Check Japanese" button, fires LLM call with input text | #2a (panel) |
| 3b | Structured output parsing + display | 3a |
| 3c | Context injection (recent messages for register awareness) | 3b |
| 3d | "Apply fix" buttons for interactive correction | 3b |
| 3e | Level-aware prompting | #7 (tracking) |

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
| Phase | Scope | Depends On |
|-------|-------|-----------|
| 4a | Search index over local JMdict (English + kana + kanji) | Nothing |
| 4b | Search UI (input + result list) — modal or panel | 4a |
| 4c | Result actions: copy, insert, open tooltip | 4b |
| 4d | Jisho API fallback for extended results | 4b |
| 4e | "Search Jisho" button in tooltips opens results in-app | 4d |

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
| Phase | Scope | Depends On |
|-------|-------|-----------|
| 5a | "Save for Anki" button on tooltip, stores to queue | Nothing |
| 5b | Export queue UI (review, remove) | 5a |
| 5c | CSV export (Anki-compatible) | 5b |
| 5d | AnkiConnect detection + one-click add | 5a |
| 5e | LLM-enhanced card fields | 5b, #2a |
| 5f | Auto-suggested cards from tracking | #7 |

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
| Phase | Scope | Depends On |
|-------|-------|-----------|
| 6a | Replace binary check with graduated algorithm | #1, #7 |
| 6b | Visibility threshold slider setting | 6a |
| 6c | Per-word override (force show/hide on specific words) | 6a, #7 |

---

## 7. Granular Word & Kanji Tracking

### Problem
Only kanji tracked (binary known/unknown). No word-level tracking. Can't determine if user knows a word, how often they've seen it, whether they use it.

### Idea
Comprehensive word-level tracking: familiarity levels, encounter history, timestamps, user-initiated marks. This is the **foundation** for #5, #6, adaptive difficulty, and LLM feedback loop.

### Data Model
```javascript
// Full entry (user has interacted)
{
  level: 3,           // 0=unknown, 1=seen, 2=recognized, 3=known, 4=mastered
  seenCount: 12,      // in LLM output
  usedCount: 3,       // user wrote it
  firstSeen: "...", lastSeen: "...", lastUsed: "...",
  levelChanged: "...",
  flags: ["hard"]     // "hard", "leech", "never-show", "anki-queued"
}
// Compact entry (auto-tracked only, no interaction yet)
{ s: 5, l: "2024-04-01" }  // seenCount, lastSeen
```

**Levels:** 0=Unknown → 1=Seen → 2=Recognized → 3=Known → 4=Mastered

### The Strictness Problem
Tooltips show all interpretations (generous). Tracking must be strict about WHAT counts.

`行きます` in text → track `行く` (dictionary form, primary match). Do NOT track `行き` (different word) or `増す` (unrelated parse of ます).

**Rule:** Track only the primary match from the token matcher — the longest greedy span's best dictionary form. Not sub-matches, not alternatives.

### Auto vs Explicit Tracking
- **Auto (silent):** seenCount increment, firstSeen/lastSeen, level 0→1 on first encounter, level 1→2 on tooltip hover
- **Explicit (user action):** All transitions above level 2, flags, level decreases

### Tooltip Quick-Actions
- ✓ Know it (→ level 3)
- ↑ Getting there (increment level)
- ↓ Hard (add flag, optionally decrease)
- 📎 Save for Anki (add flag)

### Scale & Storage
See [Storage Strategy](#9-storage-strategy). Thousands of words over time. Compact format for auto-tracked, full format only when user interacts.

### Phases
| Phase | Scope | Depends On |
|-------|-------|-----------|
| 7a | Data model + storage infrastructure | Storage (#9) |
| 7b | Auto-track seenCount for primary matches | 7a |
| 7c | Tooltip buttons: Know/Hard/Anki-queue | 7a |
| 7d | Track user-written words (tokenize input on send) | 7a |
| 7e | Level progression logic | 7b, 7c |
| 7f | Migrate kanji known state to new format | 7a |
| 7g | Expose tracking data to LLM prompts (macro/context) | 7e |

---

## 8. Implementation Order

Features interleaved by phase for maximum early value:

```
Sprint 1: Foundations
  7a  - Word tracking data model + storage infra
  1a  - Frequency pipeline (build script, N-list format)
  4a  - Search index over local JMdict

Sprint 2: First Visible Features
  1b  - Import first frequency list
  1c  - Frequency badges in tooltip
  4b  - Search UI (modal with input + results)
  7b  - Auto-track seenCount during processing
  7c  - Tooltip mark buttons (Know/Hard)

Sprint 3: Side Chat MVP
  2a  - Side panel UI + LLM call wrapper
  2b  - Tooltip buttons → explain/translate → panel
  4c  - Search result actions (copy, insert)
  5a  - "Save for Anki" button on tooltip

Sprint 4: Integration
  1d  - Second frequency list (Netflix/Anime)
  2c  - Structured prompts with full context
  3a  - "Check Japanese" pre-send button
  6a  - Graduated furigana visibility algorithm

Sprint 5: Polish & Export
  5b,5c - Anki export queue + CSV
  3b  - Structured feedback display
  1e  - Frequency list settings/weights
  6b  - Visibility threshold slider
  7d  - Track user-written words
```

This order ensures: foundational data layers first → visible features quickly → LLM features once panel exists → integration features that combine everything.

---

## 9. Storage Strategy

### The Problem
Word tracking data will grow large (thousands of entries over months). SillyTavern's `extension_settings` is JSON-serialized on every `saveSettingsDebounced()` call. Bloating it with tracking data would slow all settings saves.

### Solution: Tiered Storage

**Tier 1: extension_settings (small, critical data)**
- User preferences/settings (current approach, unchanged)
- Known kanji map (existing, small — ~3000 entries max)
- A few hundred explicitly-marked words (level ≥ 3)

**Tier 2: Separate file via ST files endpoint (large, non-critical data)**
- Full word tracking database (all auto-tracked entries)
- Side chat history (persistent conversations)
- Anki export queue

ST's files endpoint (`/api/files/upload`, `/api/files/get`) allows uploading/downloading arbitrary files to the user's data directory. It's designed for file attachments but works for any file. The extension:
1. Maintains an in-memory tracking database
2. Debounced saves to a JSON file via the files endpoint (separate from settings save cycle)
3. Loads the file on extension init

**File path:** `user/files/nihongo-helper/tracking.json` (or similar)

**Benefits:**
- Settings saves remain fast (small payload)
- Tracking data saves can be less frequent (every 30s or on visibility change)
- No size concern — JSON file can grow freely
- Backup/restore is just a file copy

### Implementation Notes
- Custom `saveTrackingDebounced()` with longer interval than settings (30s vs instant)
- Save on `beforeunload` / `visibilitychange` for safety
- Graceful handling if file doesn't exist yet (first run)
- Consider splitting into multiple files if tracking exceeds ~5MB (unlikely for most users)

---

## 10. Technical Notes

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

### Side Chat Prompt Template Example
```
System: You are a Japanese language tutor helping a student who is reading
Japanese chat messages. They know {knownKanjiCount} kanji. Answer concisely
and at their level. Use furigana for words they likely don't know.

The student asks about: {word} ({reading})
Context sentence: {sentence}
Action: {explain|translate|alternatives|grammar}
```

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
During `addFuriganaToText` processing, after `analyzeTokens` returns greedy spans:
- For each span with `matches.length > 0`:
  - Take `matches[0]` (primary/best match)
  - Extract dictionary form (the matched word, not the surface)
  - Increment `seenCount` in tracking store
- Only track spans whose primary match is the full-span match (not sub-matches)
- Ignore single-kana particles and punctuation tokens
