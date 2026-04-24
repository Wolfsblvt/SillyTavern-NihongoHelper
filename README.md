# SillyTavern-NihongoHelper

A SillyTavern extension to help with learning Japanese through chat interactions.

## Status: Work in Progress 🚧

## Features

### Implemented
- [x] **Auto Furigana** — Automatically adds furigana (reading annotations) above kanji in chat messages
  - Works during streaming (real-time, throttled)
  - Covers both message text and reasoning blocks
  - Handles edits, swipes, chat changes, lazy loading
- [x] **Hover-only Mode** — Furigana only appears on hover, with space reserved to prevent layout shifts
- [x] **Font Size Controls** — Adjustable Japanese text size and furigana scale via range sliders
- [x] **Settings Panel** — Enable/disable furigana, hover mode, font sizes, streaming interval

### Planned
- [ ] **Kanji Manager** — Comprehensive kanji browser/manager popup
  - Browse kanji by JLPT level, RTK order, frequency, school grade
  - Per-kanji detail view with meanings, readings, frequency stats
  - Mark kanji as "known" to exclude from furigana
  - Smart partial furigana: only shows readings for unknown kanji
  - Extensible data model for future integrations (Jisho, etc.)
- [ ] **`{{knownKanji}}` Macro** — Expose known kanji list for use in system prompts
- [ ] **Vocabulary Sidebar / Popup** — Click any word with furigana to see dictionary entry, meanings, example sentences
- [ ] **Feedback/Correction Renderer** — Styled rendering for AI correction blocks (grammar, translation, notes)
- [ ] **Word Frequency Highlights** — Color-code kanji/words by JLPT level or frequency tier
- [ ] **Session Vocabulary Log** — Collect new words from conversations into a reviewable list; export to Anki CSV (manual trigger, not necessarily fully automatic)

### Maybe / Future Ideas
- [ ] **Grammar Pattern Detection** — Highlight grammar patterns (て-form, conditional, passive, etc.) with hover tooltips
- [ ] **Reading Practice Mode** — Hide all kanji and show only furigana, forcing hiragana reading
- [ ] **Adaptive Difficulty System** — Track exposure to words/grammar; feed into system prompt for gradual complexity increase
- [ ] **Conversation Review Mode** — Post-session structured review: new vocab, grammar points, common mistakes (slash command)
- [ ] **Kanji Detail on Hover/Click in Text** — Shift+hover or click on any kanji in chat to see details inline
- [ ] **Jisho Integration** — Link to or fetch data from Jisho.org for detailed kanji/word lookups

## Installation

Install via SillyTavern's extension installer or clone into `public/scripts/extensions/third-party/`.

## Dependencies

- **kuromoji.js** — Japanese morphological analyzer for deterministic furigana generation (bundled in `lib/`)

## License

GPL-3.0
