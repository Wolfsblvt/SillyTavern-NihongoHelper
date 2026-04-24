# SillyTavern-NihongoHelper

A SillyTavern extension to help with learning Japanese through chat interactions.

## Status: Work in Progress 🚧

## Features

### Implemented
- [ ] **Auto Furigana** — Automatically adds furigana (reading annotations) above kanji in chat messages
  - Works during streaming (real-time)
  - Covers both message text and reasoning blocks
- [ ] **Hover-only Mode** — Furigana only appears on hover, with space reserved to prevent layout shifts
- [ ] **Settings Panel** — Enable/disable furigana, toggle hover mode

### Planned
- [ ] **Known Kanji Management** — Mark kanji as "known" to exclude them from furigana
  - Searchable kanji list
  - Sorted by frequency of use (using standard frequency data)
  - Toggle individual kanji as known/unknown
  - Known kanji are excluded from furigana annotations
  - Smart partial furigana: only shows readings for unknown kanji portions
- [ ] **Known Kanji Macro** — Expose known kanji list via a `{{knownKanji}}` macro for use in system prompts
- [ ] **System Prompt Templates** — Pre-built prompt templates for Japanese language learning scenarios
- [ ] **Feedback/Correction Display** — Rendered display block for AI feedback on user messages (grammar corrections, translation, intended meaning)
- [ ] **Character Card Support** — Guidance and templates for building a Japanese learning assistant character

## Installation

Install via SillyTavern's extension installer or clone into `public/scripts/extensions/third-party/`.

## Dependencies

- **kuromoji.js** — Japanese morphological analyzer for deterministic furigana generation (bundled in `lib/`)

## License

GPL-3.0
