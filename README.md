# NihongoHelper

[![Status: pre-release](https://img.shields.io/badge/status-pre--release-f59e0b)](#project-status)
[![SillyTavern: third-party extension](https://img.shields.io/badge/SillyTavern-third--party%20extension-6b7280)](#compatibility)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-3b82f6)](LICENSE)

Japanese reading, lookup, and optional tutor feedback inside SillyTavern.

NihongoHelper is for people who already read, write, roleplay, or converse in Japanese in SillyTavern and want help without breaking the flow of the chat. It adds automatic furigana, local dictionary and kanji inspection, study-state controls, a side-panel language assistant, and review tools for Japanese you write.

> [!IMPORTANT]
> NihongoHelper is an independent third-party extension. It is not maintained by, affiliated with, or endorsed by the SillyTavern project.

> [!WARNING]
> This is pre-release software (`0.1.0`). Reading and lookup are the most mature paths. Tutor chat, writing feedback, and word-confidence tracking are experimental and can still change.

## What it does

| Area | Current experience | Model request? |
| --- | --- | --- |
| Reading | Adds furigana to Japanese chat text, including streamed and updated messages. Furigana can be always visible, hover-only, or hidden for words whose kanji you marked as known. | No |
| Lookup | Shows readings, grouped JMdict meanings, part of speech, inflection/base-form information, kanji details, and frequency data from bundled resources. | No |
| Kanji study | Lets you mark kanji as unknown, learning, or known; browse and filter the Kanji Manager; and expose that state through SillyTavern macros. | No |
| Language Assistant | Opens a side-panel tutor for a selected word, sentence, or free-form Japanese question. Bundled tutor presets cover balanced help, strict correction, immersion, and anime/media dialogue. | Yes |
| Writing Feedback | Reviews a sent Japanese message or a draft, reports structured issues and strengths, and can stage explicit corrections before applying them. Automatic review is opt-in. | Yes |
| Word confidence | Tracks encounters and manual confidence nudges for words. This path is experimental and its learning semantics are not final. | No |

A typical local reading flow looks like this:

1. Open a chat containing Japanese.
2. Read with generated furigana.
3. Select a word, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> for Inspect Mode.
4. See its reading, dictionary form, meanings, kanji breakdown, and frequency.
5. Mark kanji as learning or known so future readings adapt.

Model-backed help is a separate step. From a word tooltip or the side panel, you can ask the active tutor to explain grammar, intent, phrasing, or alternatives. The Writing Feedback tools can review Japanese you wrote without adding the feedback itself to the main character prompt.

For the full implementation map and future work, see [Architecture](ARCHITECTURE.md) and the [roadmap](roadmap.md).

## Install

NihongoHelper is installed from its Git repository. It is not currently distributed through a tagged GitHub Release or the SillyTavern content catalogue.

1. In SillyTavern, open **Extensions**.
2. Choose **Install Extension**.
3. Paste:

   ```text
   https://github.com/Wolfsblvt/SillyTavern-NihongoHelper
   ```

4. Choose the installation target when SillyTavern offers one, then install and reload the page.

SillyTavern's Git-based extension installer requires Git on the machine running SillyTavern.

### Update

Open **Extensions → Manage extensions** and update NihongoHelper from there. Reload SillyTavern after an update if the interface does not refresh automatically.

There are currently no tagged releases. Unless you selected another branch during installation, updates follow this repository's default branch.

### Uninstall

Delete NihongoHelper from **Manage extensions**.

The extension does not currently define a cleanup hook. Removing its code therefore does not guarantee removal of saved NihongoHelper settings, user files, per-chat tutor bindings, or feedback stored with chat messages. Keep that data if you may reinstall; remove it manually only when you understand the SillyTavern storage involved.

## First five minutes

After installation:

1. Open **Extensions** and expand **Nihongo Helper**.
2. No model configuration is needed for reading and lookup. The **Connection profile** setting matters only when you invoke model-backed features.
3. Open a chat with Japanese text. Furigana is enabled by default.
4. Select Japanese text to open a word tooltip, or enable Inspect Mode with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>.
5. Open **Kanji Manager** from the settings panel to mark kanji as learning or known.
6. Configure a Connection Manager profile only when you want the Language Assistant or Writing Feedback to use a dedicated model connection.

Useful reading controls include:

- always-visible or hover-only furigana;
- Japanese-text and furigana size;
- meaning spoilers that reveal immediately, on hover, or after a delay;
- selection lookup and optional kana-only tooltips;
- hiding furigana when every kanji in a word is known;
- known-kanji highlighting and learning-kanji underlining;
- left- or right-side lookup and tutor panels.

## Language Assistant and feedback

### Language Assistant

The Language Assistant is a separate, in-page tutor conversation. You can open it from word actions or type a free-form question in its side panel.

It uses the selected Connection Manager profile when one is configured and available. Otherwise it falls back to SillyTavern's active main model connection. NihongoHelper does not implement provider-specific API clients of its own.

Tutor requests can contain:

- the selected surface word and dictionary form;
- its reading and part of speech;
- the surrounding sentence or paragraph;
- your question and the tutor preset's instructions;
- marked known and learning kanji;
- the retained Language Assistant conversation history.

Use the terminal button in the Language Assistant to inspect the assembled prompt after a request has been prepared.

The side-panel tutor conversation currently lives in memory only. Starting a new tutor conversation, reloading the page, or restarting SillyTavern can discard it.

### Writing Feedback

Writing Feedback has two entry points:

- review a Japanese message you already sent and attach a feedback card to it;
- review the current draft before sending, then explicitly apply a revision back to the composer.

The draft-review path never sends the chat message for you. Applying a correction to an already-sent message is also an explicit action and follows the configured apply policy.

Feedback requests can include the target Japanese plus a configurable number of preceding chat messages so the model can judge context and naturalness. The default is four preceding messages; set it to zero to send no conversation context.

Automatic feedback is **off by default**. Enabling it for Japanese messages creates one additional model request for each eligible message.

## Data, network, and privacy

NihongoHelper combines local extension data, SillyTavern-managed storage, and optional model requests. Those are different trust boundaries.

| Behavior | Where data goes |
| --- | --- |
| Furigana, tokenization, dictionary lookup, kanji lookup, de-inflection, and frequency lookup | The browser loads bundled files from your own SillyTavern instance. These paths do not call a language model. |
| Extension options and known/learning kanji | SillyTavern extension settings under `nihongo_helper`. |
| Word-confidence tracking | SillyTavern user-file storage as `user/files/nihongo-tracking.json`. |
| Imported tutor presets | SillyTavern user-file storage, with their index kept in extension settings. |
| Per-chat tutor choice | SillyTavern chat metadata, so the binding can travel with that chat. |
| Feedback on sent messages | Extension-owned message metadata under `message.extra.nihongoFeedback`. It is not inserted into the main character prompt by NihongoHelper. |
| Language Assistant and Writing Feedback requests | Your selected Connection Manager profile, or SillyTavern's active main model connection when no profile is selected. Provider cost, logging, retention, and geographic handling follow that connection and provider. |
| Jisho links | Jisho.org only after you choose to open an external dictionary link. |

The current runtime source does not configure a separate NihongoHelper telemetry service. It does make requests to your SillyTavern server for bundled files and saved user data, and model-backed features send the prompt content described above through SillyTavern's configured model path.

Treat imported tutor-preset JSON as configuration from a source you trust. A preset controls prompt text and the actions exposed by the Language Assistant.

## Compatibility

NihongoHelper is a browser-side SillyTavern UI extension. It has no server-plugin or Extras requirement, and its local reading dependencies are bundled in this repository.

The manifest does **not** declare a minimum SillyTavern version. The extension uses the current extension lifecycle together with several direct imports from SillyTavern's internal frontend modules. Those imports can change between SillyTavern versions.

Use a current SillyTavern release and include the exact SillyTavern branch or commit when reporting a compatibility problem. Compatibility with every older release, future release, mobile browser, theme, or third-party extension is not claimed.

A dedicated tutor profile requires SillyTavern's Connection Manager to be enabled. Without one, model-backed features use the active main model connection instead.

## Project status

NihongoHelper is under active development, but it is not release-polished:

- the manifest version is `0.1.0`;
- no tagged GitHub Releases are published;
- reading and lookup are the primary usable path;
- tutor chat, feedback, and tracking remain experimental;
- there is no declared stable SillyTavern version range;
- the repository has no packaged build step for normal use.

See the [roadmap](roadmap.md) for feature-level status. Planned items in that document are not promises or current capabilities.

## Troubleshooting

### NihongoHelper does not appear

- Confirm that Git is available to the SillyTavern server.
- Confirm that the repository URL was installed as a third-party extension.
- Reload SillyTavern and inspect the browser console for messages prefixed with `[SillyTavern-NihongoHelper]`.
- Update SillyTavern before assuming an older frontend is compatible.

### Furigana or tooltips do not appear

- Confirm **Enable furigana above kanji** is on.
- Check whether hover-only mode or **Hide furigana for known words** is hiding the reading.
- Use text selection or Inspect Mode for lookup.
- Enable **Kana word tooltips** when the target contains no kanji.
- Allow the bundled dictionary and tokenizer files to finish loading after the extension activates.

### The Language Assistant or feedback request fails

- Confirm the selected Connection Manager profile still exists and can generate outside NihongoHelper.
- Try **Use main model** to isolate a profile-specific problem.
- Check the Language Assistant's prompt viewer and the browser console.
- Remember that provider errors, quotas, content policies, and billing are controlled by the selected SillyTavern connection rather than by NihongoHelper.

### Tutor history disappeared

The Language Assistant session is not persisted yet. Main-chat feedback cards, per-chat tutor bindings, extension settings, and tracking data use separate persistent stores.

### An update behaves strangely

Reload the page first. When reporting the problem, include the NihongoHelper commit, SillyTavern commit or release, browser, reproduction steps, and relevant console output.

## Development

The extension is shipped as plain JavaScript, HTML, CSS, and committed data files. Normal users do not need Node.js or a build step after installation.

The available pure-logic check covers the Writing Feedback parser, validation, anchoring, and safe staged application:

```bash
node scripts/test-feedback.mjs
```

There is currently no repository-level `package.json`, lint command, browser test harness, or GitHub Actions workflow. Test interface changes in a current SillyTavern instance and report that live-client coordinate separately from the pure-logic test.

Data-maintenance scripts live in [`scripts/`](scripts/). They can rebuild the committed JMdict, kanji, and frequency files; they are not part of normal extension startup. See [Architecture: Build Scripts](ARCHITECTURE.md#build-scripts) before regenerating data.

Useful source entry points:

- [`manifest.json`](manifest.json) — SillyTavern extension metadata;
- [`index.js`](index.js) — activation and feature wiring;
- [`src/furigana.js`](src/furigana.js) — Japanese text processing;
- [`src/kanji-tooltip.js`](src/kanji-tooltip.js) — lookup and inspection;
- [`src/side-chat-llm.js`](src/side-chat-llm.js) — model-request boundary;
- [`src/feedback-engine.js`](src/feedback-engine.js) — writing-feedback request flow;
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — internal design and storage details.

## Support

Use [GitHub Issues](https://github.com/Wolfsblvt/SillyTavern-NihongoHelper/issues) for reproducible bugs and focused feature requests.

A useful report includes:

- the NihongoHelper commit;
- the SillyTavern release, branch, or commit;
- browser and operating system;
- whether the failure is in local reading/lookup or a model-backed feature;
- selected connection path without credentials or private prompt content;
- exact reproduction steps and relevant console messages.

Do not post API keys, private chats, provider credentials, or unredacted model prompts.

## Bundled components and data

The reading path includes committed copies or processed data derived from:

- [kuromoji.js](https://github.com/takuyaa/kuromoji.js) for Japanese morphological analysis;
- [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) for JMdict-derived dictionary data;
- [kanji-data](https://github.com/davidluzgouveia/kanji-data) for kanji metadata;
- [JPDB frequency list](https://github.com/MarvNC/jpdb-freq-list) for word-frequency ranks.

Those components and data retain their own upstream terms and notices.

## License

NihongoHelper's project code is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0`). Bundled third-party code and data remain subject to their respective upstream licences.
