import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { buildAdmin } from "./admin.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { createEngine, type Engine, type Item } from "./engine.ts";
import { entriesOf, loadGlossaryFile, setEntries, type Entry } from "./glossary.ts";
import { normalize } from "./lang.ts";
import { openAiChat, type Chat } from "./llm.ts";

const MAX_ITEMS = 100, MAX_TEXT = 6000, MAX_WAIT = 120_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function buildApp(cfg: Config, db: Db, chat: Chat = openAiChat(cfg.llm)): { app: FastifyInstance; engine: Engine } {
  const engine = createEngine(db, chat, cfg);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" && !process.env.VITEST, bodyLimit: 2 * 1024 * 1024 });
  const started = Date.now();
  let requests = 0;

  /** The app a bearer token belongs to. */
  const appOf = (req: FastifyRequest): string | null => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token) return null;
    const row = db.prepare("SELECT app FROM tokens WHERE hash = ?").get(sha(token)) as { app: string } | undefined;
    return row?.app ?? null;
  };
  const lang = (tag: unknown, reply: FastifyReply) => {
    const n = typeof tag === "string" ? normalize(tag, cfg.langs) : null;
    if (!n) reply.code(400).send({ error: `unsupported language ${String(tag)}; supported: ${cfg.langs.join(", ")}` });
    return n;
  };

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/v1/languages", async () => ({ languages: cfg.langs, source: cfg.sourceLang }));

  // Everything below /v1 except the language list needs a token.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/") || req.url.startsWith("/v1/languages")) return;
    const who = appOf(req);
    if (!who) return reply.code(401).send({ error: "a valid bearer token is needed" });
    (req as FastifyRequest & { app: string }).app = who;
    requests++;
  });
  const who = (req: FastifyRequest) => (req as FastifyRequest & { app: string }).app;

  app.post<{ Body: { to?: string; from?: string; texts?: Array<string | Item>; wait?: number } }>("/v1/translate", async (req, reply) => {
    const b = req.body ?? {};
    const to = lang(b.to, reply);
    if (!to) return;
    const from = b.from === undefined ? cfg.sourceLang : lang(b.from, reply);
    if (!from) return;
    if (!Array.isArray(b.texts) || b.texts.length > MAX_ITEMS) return reply.code(400).send({ error: `texts: an array of at most ${MAX_ITEMS} strings or {text, context?, kind?}` });
    const items: Item[] = b.texts.map((t) => (typeof t === "string" ? { text: t } : { text: String(t?.text ?? ""), context: typeof t?.context === "string" ? t.context.slice(0, 500) : undefined, kind: t?.kind === "name" ? "name" : undefined }));
    if (items.some((i) => i.text.length > MAX_TEXT)) return reply.code(400).send({ error: `a text is longer than ${MAX_TEXT} characters` });
    const wait = Math.min(Math.max(Number(b.wait ?? 10_000) || 0, 0), MAX_WAIT);
    return { translations: await engine.translate(who(req), items, to, { from, wait }) };
  });

  app.post<{ Body: { to?: string[]; from?: string; entries?: Record<string, string>; context?: string } }>("/v1/catalog", async (req, reply) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.to) || !b.entries || typeof b.entries !== "object") return reply.code(400).send({ error: "to: [languages], entries: {key: text}" });
    const tos: string[] = [];
    for (const t of b.to) {
      const n = lang(t, reply);
      if (!n) return;
      tos.push(n);
    }
    const from = b.from === undefined ? cfg.sourceLang : lang(b.from, reply);
    if (!from) return;
    const keys = Object.keys(b.entries).filter((k) => typeof b.entries![k] === "string");
    // The key says what a short label is for ("panel_open_url": a link that opens something, not "unresolved").
    const items = keys.map((k) => ({ text: b.entries![k]!, context: `${b.context ? `${b.context}; ` : ""}key: ${k}` }));
    const out: Record<string, Record<string, string>> = {};
    const missing: Record<string, string[]> = {};
    for (const to of tos) {
      const r = await engine.translate(who(req), items, to, { from, catalog: true });
      out[to] = Object.fromEntries(keys.map((k, n) => [k, r[n]!.text]));
      missing[to] = keys.filter((_, n) => r[n]!.source === "original");
    }
    return { catalogs: out, missing };
  });

  app.get("/v1/glossary", async (req) => ({ entries: entriesOf(db, who(req)) }));
  app.put<{ Body: { entries?: Entry[] } }>("/v1/glossary", async (req, reply) => {
    if (!Array.isArray(req.body?.entries)) return reply.code(400).send({ error: "entries: [{term, rule: keep|fixed, to?, note?}]" });
    setEntries(db, who(req), req.body.entries);
    return { entries: entriesOf(db, who(req)) };
  });

  // A person's translation of one text: wins over the model from now on.
  app.put<{ Body: { to?: string; from?: string; text?: string; translation?: string } }>("/v1/memory", async (req, reply) => {
    const b = req.body ?? {};
    const to = lang(b.to, reply);
    if (!to) return;
    const from = b.from === undefined ? cfg.sourceLang : lang(b.from, reply);
    if (!from) return;
    if (!b.text?.trim() || !b.translation?.trim()) return reply.code(400).send({ error: "text and translation are needed" });
    engine.setHuman(who(req), from, to, b.text, b.translation);
    return { ok: true };
  });
  app.get<{ Querystring: { q?: string; lang?: string; limit?: string } }>("/v1/memory", async (req) => {
    const q = `%${req.query.q ?? ""}%`;
    const rows = db.prepare(`SELECT source, from_lang AS "from", lang, text, origin, used_at, uses FROM memory WHERE app = ? AND (source LIKE ? OR text LIKE ?) ${req.query.lang ? "AND lang = ?" : ""} ORDER BY used_at DESC LIMIT ?`)
      .all(...[who(req), q, q, ...(req.query.lang ? [req.query.lang] : []), Math.min(Number(req.query.limit ?? 50) || 50, 500)]);
    return { rows };
  });

  // For a monitor: health, metrics and what this service is made of, behind their own token.
  const opsOk = (req: FastifyRequest) => !!cfg.opsToken && same(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "", cfg.opsToken);
  app.get("/ops/health", async (req, reply) => {
    if (!opsOk(req)) return reply.code(404).send();
    const s = engine.stats;
    const hour = Date.now() - 3_600_000;
    const recentFail = s.lastErrorAt > hour && s.lastErrorAt > s.lastOkAt;
    const today = db.prepare("SELECT coalesce(sum(made), 0) AS made, coalesce(sum(failed), 0) AS failed FROM usage WHERE day = date('now')").get() as { made: number; failed: number };
    const checks = [
      { id: "model", level: recentFail ? "bad" : "ok", detail: recentFail ? `the model does not answer: ${s.lastError.slice(0, 200)}` : s.lastOkAt ? "the model answers" : "no model call yet", data: { calls: s.calls, failed_calls: s.failedCalls } },
      { id: "failures", level: today.failed > 20 && today.failed > today.made ? "warn" : "ok", detail: `${today.made} texts translated today, ${today.failed} could not be`, data: today },
      { id: "queue", level: engine.pending() > 500 ? "warn" : "ok", detail: `${engine.pending()} texts being translated`, data: { pending: engine.pending() } },
    ];
    const status = checks.some((c) => c.level === "bad") ? "bad" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
    return { app: "lingo", at: new Date().toISOString(), status, checks };
  });
  app.get("/ops/metrics", async (req, reply) => {
    if (!opsOk(req)) return reply.code(404).send();
    const rows = db.prepare("SELECT app, lang, sum(hits) AS hits, sum(made) AS made, sum(failed) AS failed FROM usage GROUP BY app, lang").all() as Array<{ app: string; lang: string; hits: number; made: number; failed: number }>;
    const memory = db.prepare("SELECT app, origin, count(*) AS n FROM memory GROUP BY app, origin").all() as Array<{ app: string; origin: string; n: number }>;
    const lines = [
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
      `lingo_requests_total ${requests}`,
      "# TYPE lingo_uptime_seconds gauge",
      `lingo_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`,
    ];
    return reply.type("text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
  });
  app.get("/ops/manifest", async (req, reply) => {
    if (!opsOk(req)) return reply.code(404).send();
    let host = cfg.llm.url;
    try { host = new URL(cfg.llm.url).origin; } catch { /* keep as is */ }
    return {
      app: "lingo",
      context: "lingo translates the apps' texts. It keeps every translation (the memory) and asks the model only for what it has not seen; a text that cannot be translated is returned in its source language, so a failing model means untranslated text, not errors. Texts in the memory keep working while the model is down.",
      tools: [],
      actions: [],
      components: [
        { id: "api", name: "API", kind: "service", checks: [{ id: "queue" }, { id: "failures" }], depends_on: ["memory", "model"], description: "POST /v1/translate and /v1/catalog; answers from the memory at once, waits for the model at most as long as the caller asks." },
        { id: "memory", name: "memory (SQLite)", kind: "store", checks: [{ id: "failures" }], description: "every translation by app, source hash and language; people's corrections are never replaced." },
        { id: "model", name: "translation model", kind: "external", url: host, ...(cfg.llmApp ? { app: cfg.llmApp } : {}), checks: [{ id: "model" }], description: "an OpenAI-compatible chat endpoint." },
      ],
    };
  });

  return { app, engine };
}

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.db);
  if (cfg.glossaryFile) loadGlossaryFile(db, cfg.glossaryFile);
  const { app } = buildApp(cfg, db);
  await app.listen({ host: cfg.host, port: cfg.port });
  if (cfg.adminPort) {
    if (!cfg.adminToken) throw new Error("LINGO_ADMIN_PORT needs LINGO_ADMIN_TOKEN");
    await buildAdmin(cfg, db).listen({ host: cfg.host, port: cfg.adminPort });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => {
  console.error(err);
  process.exit(1);
});
