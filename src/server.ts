import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { buildAdmin } from "./admin.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { createEngine, type Engine, type Item } from "./engine.ts";
import { entriesOf, loadGlossaryFile, setEntries, type Entry } from "./glossary.ts";
import { normalize } from "./lang.ts";
import { openAiChat, type Chat } from "./llm.ts";
import { registerOps } from "./ops.ts";

const MAX_ITEMS = 100, MAX_TEXT = 6000, MAX_WAIT = 120_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** `now` is for tests of the checks that depend on the time. */
export function buildApp(cfg: Config, db: Db, chat: Chat = openAiChat(cfg.llm), now: () => number = Date.now): { app: FastifyInstance; engine: Engine } {
  const engine = createEngine(db, chat, cfg);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" && !process.env.VITEST, bodyLimit: 2 * 1024 * 1024 });
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

  registerOps(app, cfg, db, engine, () => requests, now);

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
