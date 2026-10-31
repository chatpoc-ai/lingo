# lingo

A translation service for one's own apps: memory, glossary, checks, any OpenAI-compatible model.
README.md is the user's guide; docs/DESIGN.md the reasons.

- TypeScript on Fastify, `node:sqlite` (Node 22.13+), no native modules. Tests with vitest and a fake model.
- This repository is public: never write hostnames, IPs, machine names, home paths, tokens or the
  names of private projects into it. Deployment details live with the deployment, not here.
- Code and comments in English; terse comments that say why.

```bash
npm test
npm run typecheck
LINGO_ENV=.env npm start
```

- `src/engine.ts`: memory lookup, batching, the model call, checks, retry, `wait`.
- `src/checks.ts`, `src/glossary.ts`, `src/lang.ts`: what must survive, terms, BCP 47 tags.
- `src/server.ts`: the HTTP API and the /ops/* routes; `src/cli.ts`: tokens, glossary, import, catalog.
- `src/client.ts`: the dependency-free client apps copy or import.
