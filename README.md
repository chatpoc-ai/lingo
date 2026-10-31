# lingo

A small translation service for your own apps. Apps write their texts in one language; when a page,
a notification or a report needs another, they ask lingo. lingo answers from its **translation
memory** when it has seen the text before, and otherwise asks a model through **any
OpenAI-compatible endpoint** (OpenAI, OpenRouter, a local Ollama or vLLM, or a gateway of your own),
**checks** the answer and keeps it.

- **One memory for everything an app shows**: UI labels, sentences produced at run time (health
  findings, AI summaries, notifications), names from configuration.
- **Never in the way**: a caller says how long it can wait; what is not ready by then comes back in
  the source language, marked `pending`, and is there next time. The client never throws.
- **Glossary**: terms that stay as they are (product names, commands) and terms with a fixed
  translation, globally and per app. When an entry changes, translations it affected are made again.
- **Checks**: placeholders (`{n}`, `%s`, `{{name}}`), code in backticks, URLs, numbers, HTML tags and
  link targets must survive, and the glossary must be followed; a wrong answer is retried once with
  what was wrong, then the source text is used.
- **People win**: a translation set by a person is used from then on and never replaced by the model.
- **Catalogs at build time**: turn your `en.json` into `ja.json`, `fr.json`… before a release, from
  the same memory, so static UI text costs nothing at run time and can be reviewed in your repo.
- **Small**: Node 22.13+, Fastify, the built-in `node:sqlite`. No native modules, no other services.

## Quick start

```bash
npm install
cp .env.example .env              # set LINGO_LLM_URL, LINGO_LLM_KEY, LINGO_MODEL
LINGO_ENV=.env npm run cli -- token create --app myapp     # prints a token once
LINGO_ENV=.env npm start
```

```bash
curl -s localhost:8790/v1/translate -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to": "ja", "texts": ["{n} parts", {"text": "Home", "kind": "name", "context": "a place where machines stand"}]}'
# {"translations":[{"text":"{n} 個の部品","source":"model"},{"text":"自宅","source":"model"}]}
```

## API

All under `/v1`, with `Authorization: Bearer <token>`; a token belongs to one app, and each app has
its own memory and glossary. Languages are BCP 47 tags (`zh-Hans`, `zh-Hant`, `ja`, `fr` …); a
tag close to a supported one is mapped to it (`zh-TW` → `zh-Hant`, `fr-CA` → `fr`).

| | |
|---|---|
| `POST /v1/translate` | `{to, from?, texts: [string \| {text, context?, kind?: "name"}], wait?}` → `{translations: [{text, source, pending?}]}` in order. `source`: `memory`, `human`, `model`, `original` (could not be had), `same`. `wait` (ms, default 10000) is how long to wait for the model. At most 100 texts of 6000 characters. |
| `POST /v1/catalog` | `{to: [lang], from?, entries: {key: text}, context?}` → `{catalogs: {lang: {key: text}}, missing: {lang: [key]}}`. Waits for everything; uses the catalog model. |
| `GET /v1/languages` | the supported languages (no token needed). |
| `GET`, `PUT /v1/glossary` | this app's entries (with the global ones it does not shadow); `PUT {entries: [{term, rule: "keep" \| "fixed", to?: {lang: text}, note?}]}` replaces this app's. |
| `PUT /v1/memory` | `{to, from?, text, translation}`: a person's translation. |
| `GET /v1/memory?q=&lang=` | search this app's memory. |

In a catalog each entry's key is sent to the model with the context (`key: panel_open_url`), which tells it what a short label is for. `context` helps the model and is not part of the memory's key: the same text gets the same
translation wherever it appears. Use a different text when you need a different translation.

For a monitor, behind `OPS_TOKEN`: `GET /ops/health` (the model answers, failures today, queue),
`GET /ops/metrics` (Prometheus), `GET /ops/manifest` (what lingo is made of). `GET /healthz` is open.

## Client

`src/client.ts` has no dependencies; copy it into an app or import it.

```ts
import { createClient, pick } from "./lingo-client.ts";
const lingo = createClient({ url: process.env.LINGO_URL!, token: process.env.LINGO_TOKEN!, timeoutMs: 3000 });
const lang = pick(req.headers["accept-language"], await lingo.languages());
const [title, detail] = await lingo.translate(["Every part, by where it runs", problem.detail], lang);
```

## CLI

```text
lingo token create --app <app> [--note <text>]   a token for an app; printed once
lingo token list
lingo glossary load <file.json> [--app <app>]    replace the global (or an app's) glossary
lingo import <file.jsonl> --app <app> --to <lang> [--from en]
                                                 translations made elsewhere: {"source"|"hash", "text"} per line
lingo catalog <en.json> --to ja,fr --out <dir>   with LINGO_URL and LINGO_TOKEN: <dir>/<lang>.json
```

`hash` is the SHA-256 of the trimmed source text, so a cache keyed the same way imports without
its source texts.

## Configuration

See [.env.example](.env.example). The model is anything that speaks `POST {LINGO_LLM_URL}/chat/completions`.
Two models can be set: `LINGO_MODEL` for texts asked for at run time (fast, cheap) and
`LINGO_CATALOG_MODEL` for catalogs (careful). With a gateway that routes by name, these can be
purpose names rather than model names.

What is sent to the model: the texts to translate, their context and the glossary entries they
mention. Do not send secrets for translation.

## Design

[docs/DESIGN.md](docs/DESIGN.md): why one source language, the three kinds of text, how the memory,
the glossary and the checks work, and what comes next (an admin page).

## License

MIT
