import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { hashOf, type Engine } from "./engine.ts";
import { readGlossaryFile, setEntries, type Entry } from "./glossary.ts";
import { normalize } from "./lang.ts";

/**
 * The OPStead ops contract (0.1) for a monitor, behind OPS_TOKEN: health, metrics, what lingo is made
 * of, read-only tools for an investigator, and a few actions it may run. Without the token (or with
 * none set) every /ops/* route answers 404.
 */

const VERSION = process.env.LINGO_VERSION || (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

// A text that cannot be translated comes back in the source language, so a few failures a day are
// noise (an odd answer, a long text); more than 20 and more than were made means the model is failing.
const FAILED_WARN = 20;
// A queue this long means texts arrive faster than the model answers; the callers get source text.
const QUEUE_WARN = 500;
// The model check trusts a failure this recent; older, with no call since, it only says so.
const MODEL_FRESH_MS = 3_600_000;
const ROWS = 50;
const DAY_MS = 86_400_000;

type Level = "ok" | "warn" | "bad";
interface Check { id: string; level: Level; subject?: string; detail: string; data?: Record<string, unknown> }
interface Param { type: "string" | "integer"; required?: true; description: string }
type Params = Record<string, string | number | undefined>;
interface Tool { description: string; params?: Record<string, Param>; network?: true; run(p: Params): unknown }
interface Action {
  /** For the owner, at most 60 characters; `description` is for the AI. */
  title: string;
  description: string;
  /** The health checks it helps with; ops offers it first on those problems. */
  checks?: string[];
  params?: Record<string, Param>;
  risk: "low" | "medium" | "high";
  limit: string;
  rollback: string | null;
  dry_run: boolean;
  network?: true;
  /** A param that is the wrong value (an unsupported language): 400. */
  invalid?(p: Params): string | null;
  /** Why it may not run now (409), or null. */
  precondition(p: Params): string | null;
  describe(p: Params): string;
  run(p: Params): Promise<{ result: string; verify?: { check: string; subject?: string; after: string } }>;
}

class Bad extends Error {}

/** The params of a tool or an action, converted; unknown fields are ignored, as the contract asks. */
function readParams(spec: Record<string, Param> = {}, raw: Record<string, unknown>): Params {
  const out: Params = {};
  for (const [name, p] of Object.entries(spec)) {
    const v = raw[name];
    if (v === undefined || v === null || v === "") {
      if (p.required) throw new Bad(`${name} is required`);
      continue;
    }
    if (p.type === "integer") {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Bad(`${name} must be an integer`);
      out[name] = n;
    } else {
      if (typeof v !== "string") throw new Bad(`${name} must be a string`);
      out[name] = v;
    }
  }
  return out;
}

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
const durationMs = (d: string) => {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(d)!;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[m[2] as "ms"];
};
/** Two glossary entries mean the same. */
const sameEntry = (a: Entry, b: Entry) => a.rule === b.rule && (a.note ?? "") === (b.note ?? "") && JSON.stringify(Object.entries(a.to ?? {}).sort()) === JSON.stringify(Object.entries(b.to ?? {}).sort());

export function registerOps(app: FastifyInstance, cfg: Config, db: Db, engine: Engine, requests: () => number, now: () => number = Date.now) {
  const started = now();
  const same = (given: string) => {
    if (!cfg.opsToken) return false;
    const x = Buffer.from(given), y = Buffer.from(cfg.opsToken);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  // The public origin only: the configured URL may carry a key in its userinfo or query.
  let endpoint: string | undefined;
  try { endpoint = new URL(cfg.llm.url).origin; } catch { /* leave it out */ }

  function health() {
    const guarded = (id: string, fn: () => Check): Check => {
      try {
        return fn();
      } catch (err) {
        return { id, level: "bad", detail: `could not be checked: ${(err as Error).message}` };
      }
    };
    const s = engine.stats;
    const checks = [
      guarded("db", () => {
        const t0 = Date.now();
        db.prepare("SELECT 1 FROM memory LIMIT 1").get();
        return { id: "db", level: "ok", detail: `the SQLite file answered in ${Date.now() - t0} ms` };
      }),
      guarded("model", () => {
        const data = { calls: s.calls, failed_calls: s.failedCalls, last_ok_at: iso(s.lastOkAt), last_error_at: iso(s.lastErrorAt) };
        if (!s.lastFailed) return { id: "model", level: "ok", detail: s.lastOkAt ? "the model answered its last call" : "no model call yet", data };
        const fresh = now() - s.lastErrorAt < MODEL_FRESH_MS;
        const ago = Math.round((now() - s.lastErrorAt) / 60_000);
        return { id: "model", level: fresh ? "bad" : "warn", detail: `the model's last call, ${ago} min ago, failed: ${s.lastError.slice(0, 200)}`, data };
      }),
      guarded("failures", () => {
        const t = db.prepare("SELECT coalesce(sum(made), 0) AS made, coalesce(sum(failed), 0) AS failed FROM usage WHERE day = date('now')").get() as { made: number; failed: number };
        if (!t.made && !t.failed) return { id: "failures", level: "ok", detail: "no text went to the model today, nothing to judge", data: t };
        return { id: "failures", level: t.failed > FAILED_WARN && t.failed > t.made ? "warn" : "ok", detail: `${t.made} texts translated today, ${t.failed} could not be`, data: t };
      }),
      guarded("queue", () => {
        const n = engine.pending();
        return { id: "queue", level: n > QUEUE_WARN ? "warn" : "ok", detail: `${n} texts being translated`, data: { pending: n } };
      }),
    ];
    const status: Level = checks.some((c) => c.level === "bad") ? "bad" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
    return { app: "lingo", version: VERSION, at: new Date(now()).toISOString(), status, checks };
  }

  function metrics() {
    const rows = db.prepare("SELECT app, lang, sum(hits) AS hits, sum(made) AS made, sum(failed) AS failed FROM usage GROUP BY app, lang").all() as Array<{ app: string; lang: string; hits: number; made: number; failed: number }>;
    const memory = db.prepare("SELECT app, origin, count(*) AS n FROM memory GROUP BY app, origin").all() as Array<{ app: string; origin: string; n: number }>;
    return [
      "# TYPE lingo_texts_total counter",
      ...rows.flatMap((r) => (["hits", "made", "failed"] as const).map((k) => `lingo_texts_total{app="${r.app}",lang="${r.lang}",outcome="${k}"} ${r[k]}`)),
      "# TYPE lingo_memory_rows gauge",
      ...memory.map((m) => `lingo_memory_rows{app="${m.app}",origin="${m.origin}"} ${m.n}`),
      "# TYPE lingo_model_calls_total counter",
      `lingo_model_calls_total{outcome="ok"} ${engine.stats.calls - engine.stats.failedCalls}`,
      `lingo_model_calls_total{outcome="failed"} ${engine.stats.failedCalls}`,
      "# TYPE lingo_pending gauge",
      `lingo_pending ${engine.pending()}`,
      "# TYPE lingo_requests_total counter",
      `lingo_requests_total ${requests()}`,
      "# TYPE lingo_uptime_seconds gauge",
      `lingo_uptime_seconds ${Math.round((now() - started) / 1000)}`,
      "",
    ].join("\n");
  }

  const lang = (tag: unknown, name: string) => {
    const n = typeof tag === "string" ? normalize(tag, cfg.langs) : null;
    if (!n) throw new Bad(`${name}: unsupported language ${String(tag)}; supported: ${cfg.langs.join(", ")}`);
    return n;
  };

  const tools: Record<string, Tool> = {
    model_status: {
      description: "The model lingo calls (endpoint origin and model names), its calls and failures since start, and the last error it gave",
      run: () => {
        const s = engine.stats;
        return { endpoint, model: cfg.llm.model, catalog_model: cfg.llm.catalogModel, calls: s.calls, failed_calls: s.failedCalls, last_ok_at: iso(s.lastOkAt), last_error_at: iso(s.lastErrorAt), last_error: s.lastError.slice(0, 300), pending: engine.pending(), started_at: iso(started) };
      },
    },
    usage: {
      description: "Texts per day, app and language over the last days: from memory (hits), made by the model, and could not be translated (failed), newest first",
      params: { app: { type: "string", description: "only this app" }, days: { type: "integer", description: "how many days back, 1 to 30 (default 7)" } },
      run: (p) => {
        const days = (p.days as number | undefined) ?? 7;
        if (days < 1 || days > 30) throw new Bad("days must be 1 to 30");
        const rows = db.prepare(`SELECT day, app, lang, hits, made, failed FROM usage WHERE day > date('now', ?) ${p.app ? "AND app = ?" : ""} ORDER BY day DESC, app, lang LIMIT ${ROWS}`)
          .all(...[`-${days} days`, ...(p.app ? [p.app as string] : [])]);
        return { rows };
      },
    },
    lookup: {
      description: "What the memory holds for one source text of an app: each language's translation, who made it (model, human, import), whether a person reviewed it, and when it was last used",
      params: { app: { type: "string", required: true, description: "the app the text belongs to" }, text: { type: "string", required: true, description: "the source text, exactly" }, lang: { type: "string", description: "only this language" }, from: { type: "string", description: "the source language (default the configured one)" } },
      run: (p) => {
        const from = p.from === undefined ? cfg.sourceLang : lang(p.from, "from");
        const to = p.lang === undefined ? undefined : lang(p.lang, "lang");
        const rows = db.prepare(`SELECT lang, text, origin, reviewed, model, created_at, used_at, uses FROM memory WHERE app = ? AND hash = ? AND from_lang = ? ${to ? "AND lang = ?" : ""} ORDER BY lang LIMIT ${ROWS}`)
          .all(...[p.app as string, hashOf(p.text as string), from, ...(to ? [to] : [])]) as Array<{ reviewed: number }>;
        return { from, rows: rows.map((r) => ({ ...r, reviewed: !!r.reviewed })) };
      },
    },
  };

  let probing = false;
  const target = cfg.langs.find((l) => l !== cfg.sourceLang);
  const row = (p: Params) =>
    db.prepare("SELECT text, origin, reviewed FROM memory WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ?").get(p.app as string, hashOf(p.text as string), p.from as string, p.lang as string) as { text: string; origin: string; reviewed: number } | undefined;
  const glossaryDiff = () => {
    const file = readGlossaryFile(cfg.glossaryFile!);
    const seen = new Set<string>();
    for (const e of file) {
      if (seen.has(e.term)) throw new Error(`the file lists "${e.term}" twice`);
      seen.add(e.term);
    }
    const now = (db.prepare("SELECT term, rule, tr, note FROM glossary WHERE scope = '*'").all() as Array<{ term: string; rule: Entry["rule"]; tr: string; note: string }>).map((r) => ({ term: r.term, rule: r.rule, to: JSON.parse(r.tr) as Record<string, string>, note: r.note || undefined }));
    const before = new Map(now.map((e) => [e.term, e]));
    const after = new Map(file.map((e) => [e.term, e]));
    return {
      file,
      added: file.filter((e) => !before.has(e.term)).map((e) => e.term),
      removed: now.filter((e) => !after.has(e.term)).map((e) => e.term),
      changed: file.filter((e) => before.has(e.term) && !sameEntry(before.get(e.term)!, e)).map((e) => e.term),
    };
  };
  const list = (terms: string[]) => (terms.length > 20 ? `${terms.slice(0, 20).join(", ")} and ${terms.length - 20} more` : terms.join(", "));
  const diffText = (d: ReturnType<typeof glossaryDiff>) => [d.added.length && `add ${list(d.added)}`, d.removed.length && `remove ${list(d.removed)}`, d.changed.length && `change ${list(d.changed)}`].filter(Boolean).join("; ");

  const actions: Record<string, Action> = {
    probe_model: {
      title: "Ask the model if it answers now",
      checks: ["model"],
      description: "Sends one fixed test text to the model, kept nowhere, so the model check says whether the model answers now rather than what its last call did",
      risk: "low",
      limit: "6/1h",
      rollback: null,
      dry_run: true,
      network: true,
      precondition: () => (probing ? "a probe is already running" : !target ? "no language other than the source language is configured" : !engine.stats.lastFailed ? (engine.stats.lastOkAt ? "the model answered its last call" : "no model call has failed since lingo started") : null),
      describe: () => `send one test text to ${cfg.llm.model}${endpoint ? ` at ${endpoint}` : ""}`,
      run: async () => {
        probing = true;
        try {
          const r = await engine.probe(target!);
          return r.ok ? { result: `${cfg.llm.model} answered`, verify: { check: "model", after: "1m" } } : { result: `${cfg.llm.model} still does not answer: ${r.error}` };
        } finally {
          probing = false;
        }
      },
    },
    retranslate: {
      title: "Translate this text again",
      description: "Forgets one translation the model made and nobody reviewed, so the model makes it again the next time it is asked for (until then the source text is shown); a person's correction, an import or an approved translation is never touched",
      params: { app: { type: "string", required: true, description: "the app the text belongs to" }, text: { type: "string", required: true, description: "the source text, exactly" }, lang: { type: "string", required: true, description: "the language of the translation" }, from: { type: "string", description: "the source language (default the configured one)" } },
      risk: "medium",
      limit: "20/1d",
      rollback: null,
      dry_run: true,
      invalid: (p) => {
        p.from = p.from === undefined ? cfg.sourceLang : lang(p.from, "from");
        p.lang = lang(p.lang, "lang");
        return p.from === p.lang ? "lang is the source language" : null;
      },
      precondition: (p) => {
        const r = row(p);
        if (!r) return `the memory has no ${p.lang} translation of this text`;
        if (r.origin !== "model") return r.origin === "human" ? "it is a person's correction" : "it was imported";
        if (r.reviewed) return "a person has reviewed it";
        return null;
      },
      describe: (p) => `forget the model's ${p.lang} translation "${row(p)!.text.slice(0, 200)}"`,
      run: async (p) => {
        const r = db.prepare("DELETE FROM memory WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ? AND origin = 'model' AND reviewed = 0").run(p.app as string, hashOf(p.text as string), p.from as string, p.lang as string);
        return { result: r.changes ? `forgot the ${p.lang} translation; it is made again when next asked for` : "nothing to forget" };
      },
    },
    reload_glossary: {
      title: "Reload the global glossary from its file",
      description: "Reads the global glossary file (LINGO_GLOSSARY) into the database again, as a restart does: global entries added by hand since are dropped, and the model's translations that used a changed term are made again when next asked for",
      risk: "medium",
      limit: "3/1d",
      rollback: null,
      dry_run: true,
      precondition: () => {
        if (!cfg.glossaryFile) return "no glossary file is configured (LINGO_GLOSSARY)";
        let d;
        try {
          d = glossaryDiff();
        } catch (err) {
          return `the glossary file cannot be used: ${(err as Error).message.slice(0, 200)}`;
        }
        return d.added.length || d.removed.length || d.changed.length ? null : "the database already matches the file";
      },
      describe: () => `replace the global glossary with the file's ${glossaryDiff().file.length} entries: ${diffText(glossaryDiff())}`,
      run: async () => {
        const d = glossaryDiff();
        setEntries(db, "*", d.file);
        return { result: `the global glossary has the file's ${d.file.length} entries: ${diffText(d)}` };
      },
    },
  };

  const kept = db.prepare("SELECT status, body FROM ops_actions WHERE key = ? AND at > datetime('now', '-1 day')");
  const runsSince = db.prepare("SELECT count(*) AS n FROM ops_actions WHERE name = ? AND status = 200 AND at > datetime('now', ?)");
  const log = db.prepare("INSERT INTO ops_actions (name, params, reason, key, status, body) VALUES (?, ?, ?, ?, ?, ?)");
  const running = new Map<string, Promise<{ status: number; body: unknown }>>();

  /** Params (400), preconditions and the limit (409), dry run, then run once per Idempotency-Key and log it. */
  async function runAction(name: string, body: unknown, key: string | undefined): Promise<{ status: number; body: unknown }> {
    const action = Object.hasOwn(actions, name) ? actions[name]! : undefined;
    if (!action) return { status: 404, body: { error: `unknown action ${name}` } };
    if (key) {
      const prior = kept.get(key) as { status: number; body: string } | undefined;
      if (prior) return { status: prior.status, body: JSON.parse(prior.body) };
      const inflight = running.get(key);
      if (inflight) return inflight;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "the body must be a JSON object of params plus reason" } };
    const b = body as Record<string, unknown>;
    if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") return { status: 400, body: { error: "dry_run must be true or false" } };
    if (b.reason !== undefined && typeof b.reason !== "string") return { status: 400, body: { error: "reason must be a string" } };
    let p: Params;
    try {
      p = readParams(action.params, b);
      const why = action.invalid?.(p);
      if (why) return { status: 400, body: { error: why } };
    } catch (err) {
      if (err instanceof Bad) return { status: 400, body: { error: err.message } };
      throw err;
    }
    const [n, per] = action.limit.split("/") as [string, string];
    const done = (runsSince.get(name, `-${Math.round(durationMs(per) / 1000)} seconds`) as { n: number }).n;
    const why = done >= Number(n) ? `it has run ${done} times in the last ${per}, its limit` : action.precondition(p);
    if (why) return { status: 409, body: { error: why } };
    if (b.dry_run === true) return { status: 200, body: { dry_run: true, would: action.describe(p) } };

    const work = (async () => {
      let reply: { status: number; body: unknown };
      try {
        reply = { status: 200, body: await action.run(p) };
      } catch (err) {
        reply = { status: 500, body: { error: (err as Error).message.slice(0, 300) } };
      }
      // Only a run that did what it said is answered again for its key; a failure may be retried.
      const keep = reply.status === 200 && key ? key : null;
      if (keep) db.prepare("UPDATE ops_actions SET key = NULL WHERE key = ?").run(keep);
      log.run(name, JSON.stringify(p), String(b.reason ?? "").slice(0, 1000), keep, reply.status, JSON.stringify(reply.body));
      return reply;
    })();
    if (key) running.set(key, work);
    try {
      return await work;
    } finally {
      if (key) running.delete(key);
    }
  }

  const manifest = () => ({
    app: "lingo",
    contract: "0.1",
    version: VERSION,
    context: "lingo translates the texts of its owner's other apps. Each app has a token; it sends texts in its source language (English by default) and gets them back in another. Every translation is kept (the memory), so the model is asked only for what lingo has not seen, and texts in the memory keep working while the model is down. A text that cannot be translated, or is not ready within the caller's wait, is returned in its source language: a failing model means untranslated text, not errors, and a few texts a day that fail the checks (a placeholder or number lost, a glossary term changed) are normal. Traffic follows the apps: catalogs are built in bursts before a release with a slower model, run-time texts come in small batches; quiet hours and days with no model call at all are normal, so the model check can show an old failure until the next call (probe_model refreshes it). The model is any OpenAI-compatible endpoint, often a gateway, whose own errors, quotas and timeouts show up here as model failures. People review the model's translations on the admin pages; a person's correction is never replaced.",
    components: [
      { id: "api", name: "API", kind: "service", ...(cfg.service ? { service: cfg.service } : {}), checks: [{ id: "queue" }, { id: "failures" }], depends_on: ["memory", "model"], description: "POST /v1/translate and /v1/catalog; answers from the memory at once, waits for the model at most as long as the caller asks." },
      { id: "memory", name: "memory (SQLite)", kind: "store", checks: [{ id: "db" }], description: "every translation by app, source hash and language, and the glossaries (global ones from a file read at start-up); people's corrections are never replaced." },
      { id: "model", name: "translation model", kind: "external", ...(endpoint ? { url: endpoint } : {}), ...(cfg.llmApp ? { app: cfg.llmApp } : {}), checks: [{ id: "model" }, { id: "failures" }], description: "an OpenAI-compatible chat endpoint; its outages, quotas and timeouts show as failed calls." },
    ],
    tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, ...(t.params ? { params: t.params } : {}), ...(t.network ? { network: true } : {}) })),
    actions: Object.entries(actions).map(([name, a]) => ({ name, title: a.title, description: a.description, ...(a.checks ? { checks: a.checks } : {}), ...(a.params ? { params: a.params } : {}), risk: a.risk, limit: a.limit, rollback: a.rollback, dry_run: a.dry_run })),
  });

  app.register(async (ops) => {
    ops.addHook("onRequest", async (req, reply) => {
      if (!same(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "")) return reply.code(404).send();
      reply.header("cache-control", "no-store");
    });
    ops.get("/health", async () => health());
    ops.get("/manifest", async () => manifest());
    ops.get("/metrics", async (_req, reply) => reply.type("text/plain; version=0.0.4").send(metrics()));
    ops.get<{ Params: { name: string }; Querystring: Record<string, string> }>("/tools/:name", async (req, reply) => {
      const tool = Object.hasOwn(tools, req.params.name) ? tools[req.params.name]! : undefined;
      if (!tool) return reply.code(404).send({ error: `unknown tool ${req.params.name}` });
      try {
        return tool.run(readParams(tool.params, req.query));
      } catch (err) {
        if (err instanceof Bad) return reply.code(400).send({ error: err.message });
        throw err;
      }
    });
    ops.post<{ Params: { name: string } }>("/actions/:name", async (req, reply) => {
      const key = req.headers["idempotency-key"];
      const { status, body } = await runAction(req.params.name, req.body ?? {}, typeof key === "string" && key ? key.slice(0, 200) : undefined);
      return reply.code(status).send(body);
    });
  }, { prefix: "/ops" });
}
