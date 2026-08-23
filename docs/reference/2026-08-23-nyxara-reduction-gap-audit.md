# Nyxara Reduction Gap Audit, 2026-08-23

## Meaning

This dated reference records an advisory outside-view Reduction and missing-Work audit of the exact public snapshot `Wolfsblvt/SillyTavern-NihongoHelper@84fa149ae3b68cf20cba2fe07300c508a1322001`.

It is evidence for Katja's provisional first Leitsatz setup. It is not an adopted plan, a current roadmap, repository acceptance, implementation authority, or a claim of repository-wide coverage. Katja judges the consequence of this evidence, and Wolf retains product and ratification authority.

Treat this record as coordinate-bound. Later repository changes should not be silently rewritten into this audit as though they were observed here. Correct factual errors explicitly or supersede this record with a newer dated reference.

## Scope, method, and evidence boundary

### Observed sources

This audit inspected:

- `Wolfsblvt/SillyTavern-NihongoHelper@84fa149ae3b68cf20cba2fe07300c508a1322001`, including its public tree, source, documentation, manifest, bundled data/build scripts, and reachable commit history.
- `Wolfsblvt/wolf-leitsatz@859544e37725c1c70adfcbfc75d4d4c6bb09f4bc/docs/ADOPTION.md`.
- `Wolfsblvt/wolf-leitsatz@859544e37725c1c70adfcbfc75d4d4c6bb09f4bc/docs/adoption-changelog.md`.
- The operative workflow subtraction rule in `packages/leitsatz-core/source/shared/global/80-workflow-and-verification.md`, together with the original Step 5 wording in commit `211f6d4d2caa3065ea65f972daa00a49b6a728de`.

For each material carrier, I asked the original Step 5 questions:

1. What useful present consequence does it create?
2. Is this carrier proportionate to that consequence?
3. Is there a simpler honest home?

The practical version is Wolf's test: if every gate, check, fallback, abstraction, compatibility path, and process claim disappeared, which disappearance would cause a concrete mistake now?

### Exact unobserved boundary

I did **not** inspect Katja's local `main`, which the caller reports is nine commits ahead, or the large uncommitted Session Debrief candidate. I also did not inspect the exact bytes of local commits `7c8e41c`, `f997cee`, or `e15e32a`.

The following are therefore caller-supplied local integration facts, not repository-read evidence:

- those commits establish repository guidance, provisional Vision/Direction, and a Level-3 documentation adoption;
- the last cut removes the root Architecture/Roadmap status estate and adds focused Architecture, Data, Privacy, roadmap, and dated public-audit homes;
- that cut records 602 insertions against 1,741 deletions;
- `LICENSE` remains unchanged while Wolf has not selected AGPL-3.0-only versus AGPL-3.0-or-later.

This audit cannot judge the local wording, whether the new homes duplicate one another, whether the Session Debrief candidate reintroduces gates or process prose, or whether the local reduction preserves every protection identified below. Katja must join the local audit and this public-snapshot audit.

### Evidence labels

- **Observed fact** means directly present in the named public snapshot or its reachable repository history.
- **Inference** means a consequence derived from those facts and named as such.
- **Recommendation** is advisory Work for Katja and Wolf to judge.

## Substantive judgment

**Observed fact.** The public snapshot contains a coherent product core: offline Japanese reading assistance inside SillyTavern through furigana, local JMdict/kanji data, word and kanji inspection, deinflection, and explicit known/learning kanji state.

Around that core, it also contains three much broader experimental systems:

1. a tutor and prompt-preset platform;
2. a persistent word-confidence/tracking substrate;
3. a writing-feedback review, persistence, inline-overlay, and text-application system.

By raw byte size in the exact public `src/` tree, the seven `feedback-*` modules occupy 127,309 bytes and the five side-chat/preset modules occupy 96,267 bytes. Together they are 223,576 of 466,200 source bytes, or 48.0%. That lower-bound measurement excludes their settings UI, template, and CSS carriers. It is not a quality metric, but it is a useful owner-burden signal.

**Inference.** The repository is not mainly suffering from too many defensive checks. Its larger problem is that experimental possibilities have been promoted into persistent product platforms before one supported path has earned their breadth. Core startup, settings, documentation, storage, and user-facing controls now carry futures that the README itself still calls experimental or planned.

**Recommendation.** Protect the reading loop and every guard that prevents concrete corruption, cross-chat writes, unsafe rendering, or unwanted text mutation. Reduce the three experimental platforms to the smallest touchable vertical slices. Do not preserve a mechanism because deleting it lacks a dramatic argument; require a present consequence for keeping it.

The target is not a tiny codebase. The target is a repository where the expensive parts correspond to sharp product boundaries rather than speculative optionality.

## Step 5 result: protections whose removal would be a mistake

| Carrier | Concrete mistake if removed | Judgment |
|---|---|---|
| Original-text restoration before furigana reprocessing, wrapper exclusion, and idempotence checks in `src/furigana.js` | Reprocessing can duplicate ruby readings, nest extension wrappers, or corrupt the user's displayed message text. Repository history records exactly these failures. | **Retain.** These checks sit on a demonstrated text-corruption boundary. |
| Handling of both raw `nihongo-*` and SillyTavern-sanitized `custom-nihongo-*` classes | Tooltips, known-state styling, and reprocessing fail on formatted chat messages while appearing to work in directly injected extension UI. | **Retain while this is supported SillyTavern behavior.** Prefer one named adapter/helper over repeated selector folklore when a local simplification is practical. |
| Model-output parsing, normalization, length clamping, and sanitized rendering in Writing Feedback | Malformed or adversarial model output can break rendering, escape the intended schema, or become trusted UI content. | **Retain if any model-generated feedback remains.** |
| Source hashes, exact quote anchoring, occurrence disambiguation, overlap detection, and right-to-left application | A generated suggestion can alter the wrong occurrence, apply to stale text, or corrupt adjacent edits. | **Retain if any generated edit can be applied.** If apply is removed, delete the corresponding machinery rather than keeping it “for later.” |
| Current-chat/current-message validation, request abort, and in-flight deduplication | A late request can attach or persist into another chat/message, or duplicate paid model work. | **Retain on every asynchronous model-writing path.** |
| Explicit affirmative apply to the composer and the rule that review never sends automatically | The extension can change or send user-authored text without consent. | **Retain.** This is a product boundary, not ceremony. |
| Feedback storage under extension-owned message metadata rather than main prompt content | Tutor feedback can contaminate the roleplay/main-character prompt and change subsequent generation. | **Retain if sent-message feedback remains.** |
| Graceful failure of optional local data loads | Missing frequency or dictionary data can prevent the core extension from starting. | **Retain**, but distinguish graceful degradation from silent semantic substitution. |
| One transparent view of the actual model prompt | Users and maintainers lose the ability to inspect what text/context leaves the client and diagnose prompt behavior. | **Retain one inspection surface if model features remain.** The separate per-message prompt peeks and system bars do not independently earn retention. |
| The existing pure feedback safety test in `scripts/test-feedback.mjs` | The riskiest parser, anchoring, and apply invariants can regress unnoticed. | **Retain while those behaviors remain.** Delete tests only with the deleted behavior, not before it. |

These are the load-bearing checks. Their common property is simple: each guards a present boundary where the repository has a concrete wrong outcome.

## Findings and Reduction recommendations

### R1. Stop writing learner state the repository cannot identify correctly

**Observed fact.** `src/tracking.js` documents its keys as dictionary forms and derives persistent confidence, encounter counts, levels, timestamps, and flags from them. Passive tracking is called from `trackSeenWords()` in `src/furigana.js`, which reads each rendered span's `data-word`. That value is a surface or greedy display span, not a guaranteed canonical dictionary identity. Passive encounters increase confidence. The normal formatter-hook path and the DOM-reprocessing path also do not share one obvious tracking point, making coverage path-dependent.

The public README already says tracking correctness still needs work. The tooltip nevertheless exposes confidence nudges and an “Anki queue” button. The Anki export/import path is only planned; the button currently sets an `anki-queued` flag with no completed consumer.

**Inference.** The repository is persisting a learning model before it has a stable identity model or a present adaptive product consequence. Wrong and incomplete state is worse than absent state because later analytics, adaptive furigana, or export would make decisions from it while looking authoritative.

**Recommendation.**

- Disable passive `recordSeen` persistence now.
- Remove the Anki queue button and `anki-queued` affordance until an export path exists.
- Keep explicit known/learning **kanji** state; it has a visible current consequence in furigana and inspection.
- Retain explicit word nudges only if Wolf names a current use beyond watching a percentage change. Otherwise remove the confidence UI and storage together.
- If word learning returns, key it from a canonical dictionary-entry identity, define what a confidence value changes in the product, and add one migration only when real persisted data exists.

**Concrete mistake prevented.** Shipping false learner state and later treating it as evidence.

### R2. Make the model transport contract honest

**Observed fact.** `src/side-chat-llm.js` uses a selected Connection Manager profile when available. Without one, it silently falls back to `generateRaw`. For side-chat history, that fallback joins all system messages into one string and all non-system messages into another, losing the original role and turn ordering. Preset-load failures also silently fall back to the bundled default, and the action registry can inject the default tutor's custom action into another preset.

**Inference.** These fallbacks preserve “something answered,” not the selected tutor contract. They can make a broken profile or preset look successful while changing instruction precedence, conversation structure, or tutor behavior.

**Recommendation.**

Choose one explicit v0.1 contract:

- require a valid Connection Manager profile for the multi-turn tutor and show a point-of-use unavailable/error state; or
- implement one deliberately flattened fallback protocol that labels every prior role/turn, test it, and document that it is a different transport shape.

In either case:

- do not silently replace a selected tutor with another tutor;
- reject an imported preset with no usable actions instead of borrowing behavior from the bundled default;
- keep streaming-to-nonstreaming retry only when it preserves the same profile, message sequence, and request semantics;
- surface the extra-call/cost and context-sharing boundary next to the feature, especially for automatic feedback.

**Concrete mistake prevented.** Users believing one tutor/context was sent when a materially different prompt was actually used.

### R3. Reduce Writing Feedback to one vertical slice

**Observed fact.** Writing Feedback spans schema/registry construction, prompt assembly, a shared engine, sent-message actions, automatic mode, persistent cards, provider reasoning capture, draft review, inline ruby-aware overlays, overlap stacking, staged individual fixes, whole-revision application, and policies for rewriting historical messages. Repository history shows that the clean draft-review modal existed before the later sent-message overlay and staging layers.

The draft path has a clear boundary: review the current composer text, keep a working copy, and change the real composer only after explicit apply. The existing pure test covers the parser and apply-safety rules.

**Inference.** Draft review is a complete user loop. The sent-message stack is a second product: it reviews history, persists model state, annotates formatted DOM, and edits already-sent records. Its complexity is not merely implementation detail; it creates a much larger trust and maintenance surface.

**Recommendation.**

For the provisional roadmap, retain only draft review:

- explicit “Review Japanese” entry;
- one product-owned feedback protocol;
- validated structured output;
- exact anchoring and ambiguity refusal;
- a preview/working copy;
- explicit “Apply to composer”;
- no automatic send.

Remove or shelve until repeated use asks for them:

- automatic sent-message review;
- attached persistent feedback cards;
- inline overlays and stacked underlines;
- staging against historical messages;
- historical-message rewrite policies;
- provider reasoning persistence/display;
- the globally editable protocol textarea and reset machinery.

If Katja judges sent-message review essential, keep it read-only and manual first: one compact card, no automatic mode, no inline DOM annotation, no apply, and no persisted reasoning.

**Concrete mistake prevented.** Letting an experimental tutor feature become a second message editor with cross-chat, DOM, storage, and consent obligations.

### R4. De-platform tutor presets before the first supported release

**Observed fact.** The public snapshot ships four bundled tutors. It also carries a generic user-preset platform: file upload, export, deletion, a settings index because directory listing is unavailable, slug/collision rules, a rich searchable selector, v1/v2-to-v3 migration, a default-action fallback, and per-chat metadata binding. The side chat describes its session model as “persistent-ready” even though persistence is not implemented. It exposes three history-instruction policies plus a history cap, per-turn system bars, per-turn prompt peeks, and a separate full prompt viewer.

The public history contains a strong prior reference: commit `a5818e0d538feac347bbea516997f5b85af96b` removed unused compatibility around kanji state because nothing in the wild had shipped it. `src/kanji-state.js` still retains one pre-release migration with an explicit TODO saying it can be removed before public release.

**Inference.** Bundled tutor choice may be useful. A general prompt-preset ecosystem, compatibility policy, per-chat binding model, and persistence-ready session schema do not follow automatically from that choice. They distribute owner burden across storage, metadata, UI, migrations, and failure semantics.

**Recommendation.**

- Keep one global selector among bundled tutors only if the variants are actively useful.
- Remove user import/export/delete, the settings index, slug/collision machinery, and per-chat binding unless Wolf or Katja can point to an actual imported preset or chat-specific tutor in current use.
- Remove v1/v2 preset migration before the first supported release unless an observed user file requires it.
- Delete `migrateLegacyKnownKanji` now; the code and history both say its source shape was pre-release only.
- Pick one history policy in code. Remove the three-mode settings and synthetic “[Same instructions…]” history messages.
- Keep one full prompt viewer for transparency/debugging if model features remain. Remove duplicate per-turn system bars and prompt-peek UI unless observed use earns them.
- Replace “persistent-ready” types with the smallest in-memory session shape. Add persistence when persistence itself becomes a product requirement.

Before deleting a user-data path, perform one bounded owner check for actual persisted data. That check is not a compatibility programme. If data exists, export it once or write one narrow migration; do not retain the entire platform by default.

**Concrete mistake prevented.** Maintaining a public extension framework when the current product only needs a few known tutors.

### R5. Detach experimental systems from core startup

**Observed fact.** `index.js` awaits bundled and user preset initialization before settings injection and before furigana initialization. It then unconditionally initializes dictionary search, side chat, sent-message feedback, draft feedback, selection lookup, tracking, and frequency loading. The manifest remains version `0.1.0`, and the README labels several of these paths experimental.

**Inference.** A missing or malformed tutor preset can delay or alter startup for a user who only installed the extension for furigana. Every experiment participates in the default lifecycle even when unused.

**Recommendation.**

Define the startup spine as:

1. settings needed by the reading loop;
2. explicit kanji state;
3. tokenizer/furigana;
4. local dictionary/inspection needed by the visible reading loop.

Register other surfaces lazily or behind an explicit feature enable:

- dictionary search when the side panel/search is first opened;
- tutor/profile loading when side chat is opened;
- feedback engine when review is invoked or explicitly enabled;
- frequency data when a frequency-bearing view is first used;
- no tracking load if tracking has been removed or disabled.

Optional feature failure must not block furigana. Log enough to diagnose, then show a point-of-use state.

**Concrete mistake prevented.** A speculative tutor or analytics failure making the core reading aid less touchable.

### R6. Collapse abstractions that have only one current implementation

**Observed fact.**

- `src/meaning-provider.js` presents a pluggable provider registry for JMdict, Jisho, LLM, and future backends, but registers and directly selects only JMdict.
- The frequency pipeline and runtime support N lists, configurable weights, add/remove/list/rebuild operations, and describe ZIP input. The current path uses one JPDB-derived source, and `build-frequency.cjs` immediately rejects ZIP input despite its usage prose and an unused unzip import.
- The side-chat session shape carries persistence-oriented metadata without persistence.
- Root architecture and roadmap documents in the public snapshot repeat current implementation, historical rationale, completed checklists, future programmes, and stale unsorted TODOs. Some TODOs describe features already shipped in commit history.

**Inference.** These carriers make future options look like current contracts. They add code paths and explanatory estate without a second implementation or observed need to force the abstraction.

**Recommendation.**

- Call JMdict directly until a second meaning source is selected and implemented.
- Reduce frequency to the one shipped source and rank/commonness API. Reintroduce composition only with a second real list and a stated product reason.
- Make build-script claims match behavior; either implement ZIP input or remove the claim/import.
- Remove persistence-oriented fields until persistence exists.
- Do not recreate the root status estate that the caller reports the local cut already removed. Current architecture should explain load-bearing boundaries; roadmap should name only committed next outcomes; dated references should preserve historical audits.

**Concrete mistake prevented.** Paying permanent abstraction and documentation tax for unselected futures.

### R7. Repair public trust boundaries before feature expansion

**Observed fact.**

- `README.md` says `GPL-3.0`; the committed `LICENSE` contains the GNU Affero General Public License version 3 text.
- The caller reports that Wolf has not chosen AGPL-3.0-only versus AGPL-3.0-or-later.
- The repository bundles generated JMdict, frequency, kanji, and kuromoji assets. Build/download scripts discover “latest” upstream releases or assets rather than pinning an immutable version/checksum at the call site.
- The code depends on SillyTavern formatter hooks, sanitizer class rewriting, events, files endpoints, and Connection Manager behavior, while the public manifest/README does not establish one tested SillyTavern baseline.
- No public issue or pull-request record was found for this repository during the audit. That is weak evidence only; it does not prove there are no users.

**Inference.** The repository asks users to trust bundled data, model-context handling, and host compatibility while leaving the support and provenance boundary implicit. This missing Work matters more than analytics or another tutor feature.

**Recommendation.**

- Wolf chooses the AGPL expression, then align `LICENSE`, README wording, and any manifest/package metadata in one change. Do not guess the choice in a reduction task.
- Record upstream dataset name, immutable source coordinate/version, license/provenance, build command, generated hash, and build date in one focused data/provenance home.
- Declare one tested SillyTavern version or commit range and one current Connection Manager expectation.
- Put a concise point-of-use notice beside LLM features: what text/context is sent, when an extra call occurs, where results persist, and that the selected provider may incur cost.
- Measure tokenizer/data load and frequency JSON parse cost before adding caching machinery. Use the measurement to decide whether lazy loading is sufficient.

**Concrete mistake prevented.** Users being unable to tell what software/data contract they installed or what leaves their machine.

## Useful Work missing from the frontier

The highest-value missing Work is smaller than the planned feature list.

### 1. One supported product loop

Write and test one sentence that acts as the support boundary:

> In a supported SillyTavern build, installing NihongoHelper makes Japanese chat text readable with offline furigana and local inspection without changing the underlying message.

Then name which adjacent surfaces are supported, experimental, or absent. “Experimental” must mean failure does not break that loop.

### 2. A narrow release smoke, not a verification empire

The repository currently has a valuable pure feedback safety script but no equivalent protection for its primary reading path.

Add the smallest repeatable evidence for:

- extension install and boot on the declared SillyTavern baseline;
- repeated formatting/reprocessing preserves source text;
- sanitizer-prefixed chat output still supports tooltip/state behavior;
- a representative direct lookup, deinflection, and multi-token case;
- known/learning toggles update furigana without corrupting content;
- optional model/data features can fail without blocking the reading loop.

A manual fixture plus a few pure Node assertions is enough initially. No mandatory CI programme, coverage target, test taxonomy, or release bureaucracy is earned here.

### 3. Canonical data and provenance boundaries

The extension needs one answer for “what word is this?” and one reproducible answer for “where did this bundled data come from?” before it needs richer tracking, analytics, or provider composition.

### 4. Honest model failure and privacy UX

The user should see an unavailable/error state when a tutor profile cannot run. Automatic model work must remain off by default. Context sharing and extra calls should be visible at the control that causes them.

### 5. Observation before expansion

Use actual dogfooding friction, bug reports, or repeated user requests to select the next feature. Do not create telemetry or a standing intake system merely to prove observation happened. One dated note or issue with concrete examples is enough.

## Past references and missed contradictions caught

These references should not be carried forward as accidental current contracts:

1. **Pre-release kanji migration.** `src/kanji-state.js` says the legacy `knownKanji` shape only shipped in pre-release builds and can be removed before public release. Commit `a5818e0d538feac347bbea516997f5b85af96b` states the same reduction rationale.
2. **Preset compatibility without observed installed-base evidence.** v1/v2 migration and default-action injection remain even though the repository is still `0.1.0`. Keep only if a real user preset is named.
3. **Surface tracking versus dictionary-form storage.** The tracking API promises dictionary-form keys; the observed passive caller records rendered surface spans.
4. **Anki queue before Anki export.** The tooltip exposes a queue action whose consuming product is still planned.
5. **ZIP-capable prose without ZIP capability.** `build-frequency.cjs` documents directory-or-ZIP input, then exits for every non-directory input.
6. **Provider registry without provider choice.** `meaning-provider.js` advertises pluggable backends while the public API hard-selects JMdict.
7. **Persistence-ready session without persistence.** `side-chat.js` preserves future schema burden before a persistence consequence exists.
8. **Stale roadmap TODOs.** The public roadmap's unsorted TODOs include tutor-selector/per-chat work already present in code and history. This is evidence that the status estate stopped being a trustworthy planning surface.
9. **License wording mismatch.** README and `LICENSE` name different license families; the exact AGPL variant decision remains with Wolf.
10. **Host API churn without a baseline.** Commit history includes migration away from a deprecated SillyTavern formatter API and defensive work for sanitizer-prefixed classes, but the public support baseline remains implicit.
11. **Duplicate prompt-inspection surfaces.** A full prompt viewer, per-message prompt peek, and per-turn system bars all explain overlapping internals. One transparent view earns retention; three do not.
12. **Silent semantic fallbacks.** Missing profiles, broken presets, or missing custom actions can still produce an answer by changing the transport or borrowing another preset's behavior. Availability is being preserved at the expense of truthfulness.

## Small honest roadmap

### Outcome A: stop the wrong writes

- Disable passive word-confidence tracking.
- Remove the dead-end Anki queue.
- Remove pre-release-only kanji migration.
- Make model/preset failures explicit instead of silently changing semantics.
- After Wolf's license choice, align the public license claim.

### Outcome B: make the core touchable

- Start the reading loop without awaiting tutor/preset machinery.
- Lazy-load optional search, frequency, tutor, and feedback paths.
- Reduce Writing Feedback to manual draft review.
- Reduce tutor choice to the bundled set and one history policy unless actual user data earns more.
- Keep one prompt-inspection view.

### Outcome C: prove the supported path

- Name one tested SillyTavern baseline.
- Add the narrow install/boot/reprocessing/lookup smoke.
- Pin and record bundled-data provenance and generated hashes.
- Verify optional-feature failure does not block furigana.

### Outcome D: observe before adding

Do not currently schedule:

- interaction analytics or a context warehouse;
- adaptive furigana driven by confidence;
- AnkiConnect or sync/conflict machinery;
- lorebook frameworks or example character programmes;
- continuous/automatic feedback;
- historical-message rewriting;
- a second meaning provider;
- multi-list frequency composition;
- session persistence;
- a generic preset editor or marketplace.

Any one of these may return when a repeated present friction names the consequence and the smallest carrier.

## Join notes for Katja

When joining this audit with the unobserved local Reduction and Session Debrief candidate, check four things:

1. The local documentation cut does not reintroduce the old status estate through several smaller files that repeat the same current state, future list, and decision history.
2. The focused Data and Privacy homes cover the actual bundled-data provenance and model-context boundaries above, rather than becoming generic policy prose.
3. The local Reduction preserves the must-retain text-integrity, asynchronous identity, untrusted-output, and explicit-apply protections.
4. Every retained compatibility path names real persisted data or a supported host version. “Someone may have used it” should trigger one bounded evidence check, not permanent machinery.

Caller-supplied deletion statistics suggest the local work is directionally aligned with this audit. They do not establish that the exact local result is sufficient or accepted.

## Advisory status

This record offers evidence and recommendations only. It does not accept Katja's local candidate, ratify a roadmap, change product authority, or authorize effects beyond the single dated reference commit requested for this branch.
