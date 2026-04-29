# SillyTavern-NihongoHelper

A SillyTavern extension to help with learning Japanese through chat interactions.

> [!CAUTION]
> Status: This is a work in progress 🚧

## Features

### Implemented
- [x] **Auto Furigana** — Automatically adds furigana (reading annotations) above kanji in chat messages
  - Works during streaming (real-time, throttled)
  - Covers both message text and reasoning blocks
  - Handles edits, swipes, chat changes, lazy loading
- [x] **Hover-only Mode** — Furigana only appears on hover, with space reserved to prevent layout shifts
- [x] **Font Size Controls** — Adjustable Japanese text size and furigana scale via range sliders
- [x] **Settings Panel** — Enable/disable furigana, hover mode, font sizes, streaming interval
- [x] **Kanji Manager** — Comprehensive kanji browser/manager popup (2998 kanji)
  - Browse and filter by JLPT level (N5–N1), school grade, known/unknown status
  - Sort by frequency, grade, JLPT, or stroke count with context-aware badges
  - Per-kanji detail view with meanings, on/kun readings, JLPT, grade, strokes, frequency
  - Mark kanji as "known" with date tracking — known kanji are excluded from furigana
  - Search by kanji character, meaning, or reading
  - Infinite scroll, persisted sort/filter preferences
  - Full keyboard navigation: arrow keys, Enter/Space, Escape/Backspace
  - Jisho.org integration link in detail view
- [x] **Known Kanji Highlighting** — Known kanji in chat get subtle color highlighting (toggle in settings)
- [x] **Kanji Inspect Mode** — Hover over any kanji in chat to see a tooltip with details
  - Toggle via wand menu or `Ctrl+Shift+K` shortcut
  - Tooltip shows meanings, readings, JLPT/grade/strokes/frequency tags
  - Toggle "known" status and open Jisho.org directly from the tooltip
  - Escape to exit, floating indicator bar shows active state
- [x] **Kanji Tooltip** — Compact hover tooltip available in both Kanji Manager and Inspect Mode
  - Smart positioning (right → left → below), constrained within parent
  - Known toggle, Jisho link, smooth animations
- [x] **Word Tooltip** — Hover over any word in inspect mode to see word-level details
  - Word surface form, reading, part of speech
  - **JMdict dictionary meanings** — Jisho-style grouped definitions with POS headers, numbered senses, misc notes
  - Jisho.org link for word lookup (uses `#words` search)
  - Compact kanji breakdown: each kanji in the word shown with meanings, readings, JLPT, frequency
  - Known kanji toggle (checkmark icon) per kanji in breakdown
  - On/kun reading labels (音/訓) in kanji blocks
- [x] **`{{knownKanji}}` Macro** — Comma-separated list of known kanji for use in system prompts
- [x] **`{{knownKanjiCount}}` Macro** — Number of known kanji

### Planned
- [ ] **Meaning Provider System** — Pluggable architecture for word meanings (JMdict built-in, Jisho API fallback, LLM future)
- [ ] **Vocabulary Sidebar / Popup** — Click any word with furigana to see dictionary entry, meanings, example sentences
- [ ] **Feedback/Correction Renderer** — Styled rendering for AI correction blocks (grammar, translation, notes)
- [ ] **Word Frequency Highlights** — Color-code kanji/words by JLPT level or frequency tier
- [ ] **Session Vocabulary Log** — Collect new words from conversations into a reviewable list; export to Anki CSV

### Maybe / Future Ideas
- [ ] **Grammar Pattern Detection** — Highlight grammar patterns (て-form, conditional, passive, etc.) with hover tooltips
- [ ] **Reading Practice Mode** — Hide all kanji and show only furigana, forcing hiragana reading
- [ ] **Adaptive Difficulty System** — Track exposure to words/grammar; feed into system prompt for gradual complexity increase
- [ ] **Conversation Review Mode** — Post-session structured review: new vocab, grammar points, common mistakes

## Installation

Install via SillyTavern's extension installer or clone into `public/scripts/extensions/third-party/`.

## Dependencies

- **kuromoji.js** — Japanese morphological analyzer for deterministic furigana generation (bundled in `lib/`)
- **JMdict** — Japanese-English dictionary data from [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) (CC BY-SA 4.0), 22K+ common entries (built via `scripts/build-jmdict.cjs`)

## License

GPL-3.0
