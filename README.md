# SillyTavern-NihongoHelper

A SillyTavern extension to help with learning Japanese through chat interactions.

> [!CAUTION]
> Status: This is a work in progress 🚧

## Feature Status

A compact overview of what's solid, what's still being shaped, and what's on the roadmap.
For full design context, dependencies, and phased plans see [`ROADMAP.md`](ROADMAP.md).
For internal architecture see [`ARCHITECTURE.md`](ARCHITECTURE.md).

### ✅ Stable / Usable

Day-to-day reading and lookup features that are tested and ready to use.

- **Auto Furigana** — Automatic reading annotations above kanji in chat. Works during streaming and covers reasoning blocks; handles edits, swipes, chat changes, and lazy-loaded messages.
- **Hover-only Mode** — Furigana only appears on hover, with reserved space to avoid layout shifts.
- **Font Size Controls** — Adjustable Japanese text size and furigana scale.
- **Settings Panel** — Toggle furigana, hover mode, font sizes, streaming interval, and more.
- **Kanji Manager** — Browser popup over 2998 kanji. Filter by JLPT / grade / learning status (unknown / learning / known), sort by frequency / grade / JLPT / strokes, per-kanji detail view with tri-state selector and timestamps, full keyboard navigation, Jisho.org link.
- **Known / Learning Kanji Highlighting** — Subtle color highlight for known kanji and a quieter underline for kanji actively being learned (toggleable).
- **Kanji Inspect Mode** — Toggle (`Ctrl+Shift+K` or wand menu) to hover any kanji in chat for full details.
- **Kanji Tooltip** — Compact hover tooltip with smart positioning, used in both Kanji Manager and Inspect Mode.
- **Word Tooltip** — Word-level details with grouped JMdict definitions, kanji breakdown, on/kun labels, Jisho link.
- **Inflection Detection & De-inflection** — Recognises ~100 verb/adjective patterns (masu, te, ta, negative, potential, passive, causative, volitional, conditional, progressive, …) and links inflected forms back to their dictionary form.
- **Multi-Token Matching** — Sliding-window dictionary lookup catches multi-word expressions that span kuromoji token boundaries.
- **Paginated Tooltips** — Multiple interpretations per tooltip with tab navigation (scroll, Shift+Scroll, click).
- **Kana Word Tooltips** — Optional setting to make kana-only words hoverable.
- **Hide Known Furigana** — Skip furigana on words where every kanji is already marked known.
- **Kanji Learning Mode** — Mark kanji as `learning` in addition to `known`. Learning kanji keep furigana visible (so you can still read), but are surfaced to the model via macros so it uses them naturally. Tri-state controls in the Kanji Manager and tooltips let you flip Unknown / Learning / Known with one click.
- **`{{knownKanji}}` / `{{knownKanjiCount}}` / `{{learningKanji}}` / `{{learningKanjiCount}}` macros** — Inject kanji state into system prompts to adapt LLM difficulty and bias active study.

### 🧪 Experimental / In Progress

Working but not finalised. Expect rough edges, schema changes, and behaviour shifts.

- **Word Frequency Badges** — JPDB rank shown in tooltips with tier coloring. Additional lists (Netflix/Anime, etc.), configurable weights, and chat-wide frequency coloring are still planned.
- **Dictionary Search UI** — Side-panel search tab with English / kana / kanji / romaji input and result actions (copy, insert, tooltip). Jisho fallback for rare words and example sentences is planned.
- **Language Assistant Side Chat** — Slide-out meta tutor panel for Japanese in ongoing conversation, RP, and co-writing. Bundled presets cover balanced help, strict study/correction, immersion flow, and anime/media dialogue, using your configured Connection Manager profile. Persistent / re-openable conversations are not yet saved.
- **Word Tracking & Confidence Nudges** — Tooltip Easy / Got it / Meh / Hard / Anki buttons drive a sliding confidence score. Underlying seen-count tracking, user-written word capture, and exposure to LLM prompts still need correctness work.
- **Tutor Preset System (data-driven actions)** — Tutor presets (JSON) define personality, rules, and the **action button registry** for the side chat. Each action declares its own user-facing label, description, icon, visibility (tooltip / selection / manual), and macro-aware system / user prompt templates. Adding, removing, renaming, or customizing actions is a JSON edit — no code changes. The custom / free-form action always falls back to the bundled default if a preset omits it.
- **Tutor Preset Import / Export** — Settings panel buttons next to the preset dropdown to export the active preset as JSON and import preset JSON files. Imported presets are stored under `user/files/` and become selectable immediately.
- **Writing Feedback** — Higher-order feedback on Japanese *you* write, separate from the dictionary tooltips. Two entry points share one analysis engine:
  - **Feedback on a sent message** — a per-message "Japanese feedback" action button analyses one of your messages and attaches a compact, collapsible feedback card directly beneath it (grammar, particle, conjugation, word choice, naturalness, meaning, register, context, orthography, punctuation). Each issue shows category, severity (Note / Minor / Major / Critical), confidence, the quoted phrase, a suggested replacement, an explanation, and optional alternatives, plus a summary, concrete strengths, and an optional revised version. Feedback is stored as message metadata (it never enters the main character's prompt), survives reload, becomes **stale** when you edit the message, and disappears when you delete it. Regenerate or remove from the card.
  - **Review of your draft** — a "Review Japanese" button near the composer opens a focused modal that reviews the text you're about to send (using recent conversation as context), shows the same feedback view plus an editable working copy, and lets you apply a revised version back to the composer. It never sends automatically; closing leaves your draft untouched.
  - **Inline highlights & staging** — flagged phrases can be underlined directly over your sent message (severity-coloured, surviving furigana). Click a mark for a popover with the issue details, **stage** one or more fixes (or the whole revision), preview the combined result live, then **apply them in a single edit** to the message. An `off` / `auto` / `always` setting controls when highlights appear (`auto` = your latest message), with a per-message toggle; an apply-policy setting hides *Apply* once the message is older than the latest exchange so you don't rewrite history mid-conversation.
  - **Automatic mode** *(opt-in)* — automatically review Japanese messages after you send them. Skips non-Japanese content with a cheap local check, never blocks main-chat generation, and (since it's a separate request per message) is clearly marked as costing an extra model call.
  - Configurable **sensitivity** (Essential / Balanced / Strict), **conversation-context size**, expand-by-default, **inline-highlights mode**, **apply policy**, and editable global instructions. Per-tutor feedback *style* comes from the active preset; the structured contract is owned by the extension. Uses the same connection profile as the Language Assistant.

### 🔮 Planned

Designed but not implemented. See [`ROADMAP.md`](ROADMAP.md) for rationale, dependencies, and phased plans.

- **Tracking Correctness Improvements** — Fix seen-count semantics and primary-match strictness before extending tracking further.
- **Extended Interaction Tracking** — Hover / lookup / per-action counts and a small bounded list of useful contexts per word.
- **Adaptive Furigana Visibility** — Graduated show / hover / hide based on frequency, tracking, and known-kanji state, with a single visibility slider.
- **Writing Feedback — continuous & analytics** — Continuous review while typing, mistake analytics, and Anki suggestions from recurring mistakes build on the existing Writing Feedback engine (see Experimental).
- **Anki Export** — Mark words from the tooltip → CSV or AnkiConnect, with optional LLM-enhanced fields.
- **Anki Import** — Seed tracking and known/learning state from existing Anki decks (CSV first, AnkiConnect later).
- **Lorebook / Character-Chat Prompt Framework** — Core ST world-info pack plus dynamic-state macros that make any character chat Japanese-learning aware.
- **Example Tutor / Chat Partner Characters** — Reference cards demonstrating immersive conversational use of the framework.
- **Partial Furigana Suppression** — Hide furigana only on known kanji within multi-kanji words. Experimental — falls back to whole-word furigana when reading alignment is ambiguous.
- **Grammar Pattern Detection** — Highlight grammar patterns (て-form, conditional, passive, …) with hover tooltips.
- **Reading Practice Mode** — Hide kanji and show only kana, forcing hiragana reading.
- **Conversation Review Mode** — Post-session structured review of new vocab, grammar points, and common mistakes.

## Installation

Install via SillyTavern's extension installer or clone into `public/scripts/extensions/third-party/`.

All dependencies are bundled — no internet connection or build steps required.

## Dependencies

All bundled in the repository (~50MB total):

- **kuromoji.js** — Japanese morphological analyzer for furigana generation (bundled in `lib/kuromoji/`)
- **JMdict** — Japanese-English dictionary data from [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) (CC BY-SA 4.0), 22K+ common entries (bundled in `data/jmdict.json`)
- **Kanji data** — 2998 kanji entries with JLPT, grade, frequency, meanings, readings (bundled in `data/kanji.json`)
- **Word frequency** — JPDB frequency list, ~477K entries (bundled in `data/frequency.json`)

## Rebuilding Data (Development)

The `scripts/` directory contains Node.js build scripts for updating the bundled data files from upstream sources. These are **not needed for normal use** — all data is pre-built and committed.

See [`ARCHITECTURE.md` § Build Scripts](ARCHITECTURE.md#build-scripts) for detailed usage.

## License

GPL-3.0
