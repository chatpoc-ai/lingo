# Design

## The idea

Every app writes its texts in one language, the source language (English by default). Nothing
stores a second copy by hand: no `title_fr`, no `messages.de.json` written by someone. When another
language is needed, lingo is asked. It looks the text up in its memory, asks a model only for what is
missing, checks the answer, and keeps it. The next time the same text is asked for, it costs nothing.

This works the same for three kinds of text that usually get three different treatments:

| Kind | Example | When it is translated | How |
|---|---|---|---|
| Fixed UI text | buttons, headings, `{n} parts` | before a release | `lingo catalog` turns the app's source catalog into one file per language, committed with the app. No model call at run time; a missing key falls back to the source language. |
| Text made at run time | a health check's finding, an AI summary, a notification | the first time someone reads it in a language | `POST /v1/translate` in batches; memory hits come back at once, the rest within the caller's `wait` or later |
| Names from configuration | a place, a site's title, a part's description | as above | as above, with `kind: "name"`, so proper nouns stay as they are |

## Memory

Keyed by `(app, sha256(trimmed source text), source language, target language)`.

- **Per app.** Two apps may want different words for the same English (their glossaries differ).
- **Context is not in the key.** `context` tells the model where a text appears; the same text gets
  one translation. A text that needs two translations should be two texts.
- **Origin.** `model` (made here), `human` (set by a person; never replaced by the model), `import`
  (made elsewhere and brought in; used as it is).
- **Stale.** A model translation records a fingerprint of the glossary entries that applied to it.
  When those entries change, the translation is made again the next time it is asked for; until the
  new one is ready, the old one is served.

## Asking the model

- One call per batch (20 texts at run time, 40 for catalogs), the answer a JSON object with one
  string per text, in order. Any OpenAI-compatible `chat/completions` endpoint; the JSON is read from
  the text of the answer, so no `response_format` support is required (it can be turned on).
- The prompt says what to keep (placeholders, code, URLs, numbers, tags, identifiers), that names
  keep their proper nouns, and lists only the glossary entries this batch mentions.
- **Checks** on every answer: placeholders, code in backticks, URLs, HTML tags and link targets are
  all still there; the numbers are the same (ignoring `1,370` vs `1370` and `1.5` vs `1,5`); `keep`
  terms are untouched and `fixed` terms have their translation; the answer is not empty and not far
  longer than the source. A failing text is sent once more with what was wrong; failing again, the
  source text is returned (`source: "original"`) and nothing is kept.
- **Once.** The same text asked for by several requests at the same time is made once.
- **Not in the way.** `wait` bounds how long a request waits. Texts not ready by then come back in
  the source language with `pending: true`; the work goes on and the memory has them next time.

## Glossary

Entries `{term, rule: "keep" | "fixed", to?: {lang: text}, note?}`. Global entries (from a file at
start-up, `LINGO_GLOSSARY`) apply to every app; an app's entries (`PUT /v1/glossary`) shadow global
ones with the same term. A term matches as a whole word, case-insensitively.

## Languages

BCP 47 tags, a configured list. A request's tag is mapped to the nearest supported one: Chinese by
script, then by region (`zh-TW`, `zh-HK` → `zh-Hant`; `zh`, `zh-CN` → `zh-Hans`); other languages
by their primary subtag (`fr-CA` → `fr`). The client's `pick` does the same for an Accept-Language
header. Dates and numbers are the app's job (`Intl`), not translation.

## What it is not

Not a document or file translator, not a chat or speech translator, not a place to send secrets:
texts and their context go to the configured model.

## Review

Every translation the model makes starts unreviewed. The admin pages list them, most used first, so
the texts people actually see are checked first; a person approves one, corrects it (it becomes a
person's translation, locked), or has it made again. Imports and corrections count as reviewed.

## Next

- Usage reports per app (the model's own cost is best counted by whatever serves it).
