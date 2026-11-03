import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseProviders } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { setEntries } from "../src/glossary.ts";
import { buildApp } from "../src/server.ts";
import type { Chat } from "../src/llm.ts";

const ops = { authorization: "Bearer ops-secret" };

function setup(over: Record<string, unknown> = {}) {
  let down = false, shift = 0;
  const chat: Chat = async (_m, msgs) => {
    if (down) throw new Error("model x: HTTP 503 upstream unavailable");
    const items = (JSON.parse(msgs[1]!.content) as { items: Array<{ text: string }> }).items;
    return JSON.stringify({ translations: items.map((i) => `T:${i.text}`) });
  };
  const cfg = { ...loadConfig({}), db: ":memory:", langs: ["en", "zh-Hans", "ja"], opsToken: "ops-secret", ...over };
  const db = openDb(":memory:");
  db.prepare("INSERT INTO tokens (hash, app) VALUES (?, 'shop')").run(createHash("sha256").update("tok").digest("hex"));
  const { app, engine } = buildApp(cfg, db, chat, () => Date.now() + shift);
  const translate = (texts: string[], to = "ja") => app.inject({ method: "POST", url: "/v1/translate", headers: { authorization: "Bearer tok" }, payload: { to, texts } });
  const act = (name: string, body: Record<string, unknown>, key?: string) => app.inject({ method: "POST", url: `/ops/actions/${name}`, headers: { ...ops, ...(key ? { "idempotency-key": key } : {}) }, payload: body });
  const check = async (id: string) => ((await app.inject({ url: "/ops/health", headers: ops })).json().checks as Array<{ id: string; level: string }>).find((c) => c.id === id)!;
  return { app, db, engine, translate, act, check, setDown: (d: boolean) => (down = d), later: (ms: number) => (shift += ms) };
}

describe("ops", () => {
  it("answers 404 without the token, and when none is set", async () => {
    const { app } = setup();
    for (const url of ["/ops/health", "/ops/manifest", "/ops/metrics", "/ops/tools/usage"]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
      expect((await app.inject({ url, headers: { authorization: "Bearer nope" } })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: "/ops/actions/probe_model", payload: {} })).statusCode).toBe(404);
    expect((await setup({ opsToken: undefined }).app.inject({ url: "/ops/health", headers: ops })).statusCode).toBe(404);
    // Anything else under /ops/, with the token too.
    for (const [method, url] of [["GET", "/ops/nope"], ["POST", "/ops/health"], ["GET", "/ops/actions/probe_model"], ["POST", "/ops/actions/nope"], ["DELETE", "/ops/manifest"]] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(404);
      expect((await app.inject({ method, url, headers: ops, ...(method === "POST" ? { payload: {} } : {}) })).statusCode).toBe(404);
    }
  });

  it("health: ok, then the model check bad after a failed call, warn an hour on, and failures warn", async () => {
    const { app, db, translate, check, setDown, later } = setup();
    const h = (await app.inject({ url: "/ops/health", headers: ops })).json();
    expect(h).toMatchObject({ app: "lingo", status: "ok" });
    expect(await check("failures")).toMatchObject({ level: "ok", detail: expect.stringMatching(/nothing to judge/) });
    expect(h.version).toBeTruthy();
    expect(h.checks.map((c: { id: string }) => c.id)).toEqual(["db", "model", "failures", "queue"]);
    setDown(true);
    await translate(["a"]);
    expect(await check("model")).toMatchObject({ level: "bad", detail: expect.stringMatching(/HTTP 503/) });
    later(2 * 3_600_000);
    expect(await check("model")).toMatchObject({ level: "warn", detail: expect.stringMatching(/120 min ago/) });
    db.prepare("INSERT INTO usage (day, app, lang, made, failed) VALUES (date('now'), 'shop', 'zh-Hans', 1, 30)").run();
    expect((await check("failures")).level).toBe("warn");
  });

  it("manifest: ids, cross-references, tools and actions", async () => {
    const { app } = setup({ service: "lingo-svc", providers: parseProviders("hosting:self, edge:Cloudflare") });
    const m = (await app.inject({ url: "/ops/manifest", headers: ops })).json();
    expect(m).toMatchObject({ app: "lingo", contract: "0.4" });
    const tech = Object.fromEntries(m.components.map((c: { id: string; tech?: unknown }) => [c.id, c.tech]));
    expect(tech.api).toEqual([{ name: "Node.js", version: process.versions.node }]);
    expect(tech.memory).toEqual([{ name: "SQLite", version: expect.stringMatching(/^3\.\d+\.\d+$/) }]);
    expect(tech.model).toBeUndefined();
    expect(m.providers).toEqual([{ kind: "hosting", name: "self" }, { kind: "edge", name: "Cloudflare" }]);
    const ids = new Set(m.components.map((c: { id: string }) => c.id));
    for (const c of m.components) for (const d of c.depends_on ?? []) expect(ids.has(d)).toBe(true);
    const checks = new Set(((await app.inject({ url: "/ops/health", headers: ops })).json().checks as Array<{ id: string }>).map((c) => c.id));
    for (const c of m.components) for (const k of c.checks ?? []) expect(checks.has(k.id)).toBe(true);
    expect(m.components[0].service).toBe("lingo-svc");
    expect(m.tools.map((t: { name: string }) => t.name)).toEqual(["model_status", "usage", "lookup"]);
    expect(m.actions.map((a: { name: string; risk: string }) => [a.name, a.risk])).toEqual([["probe_model", "low"], ["retranslate", "medium"], ["reload_glossary", "medium"]]);
    for (const a of m.actions) expect(a.title).toMatch(/^.{1,60}$/);
    for (const a of m.actions) for (const k of a.checks ?? []) expect(checks.has(k)).toBe(true);
    expect(m.actions[0].checks).toEqual(["model"]);
  });

  it("providers: kind:name pairs from LINGO_PROVIDERS, none when unset, an unknown kind refused", () => {
    expect(loadConfig({}).providers).toEqual([]);
    expect(loadConfig({ LINGO_PROVIDERS: "hosting:self" }).providers).toEqual([{ kind: "hosting", name: "self" }]);
    expect(parseProviders("hosting:IONOS, mail:IONOS,")).toEqual([{ kind: "hosting", name: "IONOS" }, { kind: "mail", name: "IONOS" }]);
    expect(() => parseProviders("cdn:Cloudflare")).toThrow(/LINGO_PROVIDERS/);
    expect(() => parseProviders("hosting")).toThrow(/LINGO_PROVIDERS/);
    expect(() => parseProviders("hosting:")).toThrow(/LINGO_PROVIDERS/);
  });

  it("tools validate their params and change nothing", async () => {
    const { app, db, translate } = setup();
    await translate(["Save"]);
    const before = db.prepare("SELECT * FROM memory").all();
    expect((await app.inject({ url: "/ops/tools/nope", headers: ops })).statusCode).toBe(404);
    expect((await app.inject({ url: "/ops/tools/lookup?app=shop", headers: ops })).statusCode).toBe(400);
    expect((await app.inject({ url: "/ops/tools/lookup?app=shop&text=Save&lang=xx", headers: ops })).statusCode).toBe(400);
    expect((await app.inject({ url: "/ops/tools/usage?days=x", headers: ops })).statusCode).toBe(400);
    expect((await app.inject({ url: "/ops/tools/usage?days=99", headers: ops })).statusCode).toBe(400);
    expect((await app.inject({ url: "/ops/tools/lookup?app=shop&text=Save", headers: ops })).json().rows).toEqual([expect.objectContaining({ lang: "ja", text: "T:Save", origin: "model", reviewed: false })]);
    expect((await app.inject({ url: "/ops/tools/usage?app=shop", headers: ops })).json().rows[0]).toMatchObject({ app: "shop", lang: "ja", made: 1 });
    expect((await app.inject({ url: "/ops/tools/model_status", headers: ops })).json()).toMatchObject({ calls: 1, failed_calls: 0 });
    expect(db.prepare("SELECT * FROM memory").all()).toEqual(before);
  });

  it("probe_model: 409 while the model answers, dry run, real run with verify, idempotent", async () => {
    const { act, translate, check, engine, setDown } = setup();
    expect((await act("nope", {})).statusCode).toBe(404);
    expect((await act("probe_model", { reason: "r" })).json()).toEqual({ error: "no model call has failed since lingo started" });
    await translate(["a"]);
    expect((await act("probe_model", { reason: "r" })).json()).toEqual({ error: "the model answered its last call" });
    setDown(true);
    await translate(["b"]);
    expect((await act("probe_model", { reason: "r", dry_run: "yes" })).statusCode).toBe(400);
    const made = engine.stats.calls;
    const dry = await act("probe_model", { reason: "r", dry_run: true });
    expect(dry.json()).toMatchObject({ dry_run: true, would: expect.stringMatching(/test text/) });
    expect(engine.stats.calls).toBe(made);
    const still = await act("probe_model", { reason: "r" }, "k0");
    expect(still.json().result).toMatch(/still does not answer/);
    setDown(false);
    const r = await act("probe_model", { reason: "provider back?" }, "k1");
    expect(r.json()).toEqual({ result: expect.stringMatching(/answered/), verify: { check: "model", after: "1m" } });
    expect((await check("model")).level).toBe("ok");
    const calls = engine.stats.calls;
    expect((await act("probe_model", { reason: "again" }, "k1")).json()).toEqual(r.json());
    expect(engine.stats.calls).toBe(calls);
  });

  it("retranslate: 400, 409 for a person's or a reviewed translation, dry run, run, idempotent, limit", async () => {
    const { app, db, act, translate } = setup();
    await translate(["Save", "Open"]);
    const rows = () => db.prepare("SELECT text FROM memory WHERE lang = 'ja' AND source = 'Save'").all();
    expect((await act("retranslate", { app: "shop", text: "Save", reason: "r" })).json()).toEqual({ error: "lang is required" });
    expect((await act("retranslate", { app: "shop", text: "Save", lang: "de", reason: "r" })).statusCode).toBe(400);
    expect((await act("retranslate", { app: "shop", text: "Nope", lang: "ja", reason: "r" })).statusCode).toBe(409);
    await app.inject({ method: "PUT", url: "/v1/memory", headers: { authorization: "Bearer tok" }, payload: { to: "ja", text: "Open", translation: "開く" } });
    expect((await act("retranslate", { app: "shop", text: "Open", lang: "ja", reason: "r" })).json()).toEqual({ error: "it is a person's correction" });
    db.prepare("UPDATE memory SET reviewed = 1 WHERE source = 'Save' AND lang = 'ja'").run();
    expect((await act("retranslate", { app: "shop", text: "Save", lang: "ja", reason: "r" })).json()).toEqual({ error: "a person has reviewed it" });
    db.prepare("UPDATE memory SET reviewed = 0").run();
    expect((await act("retranslate", { app: "shop", text: "Save", lang: "ja-JP", reason: "r", dry_run: true })).json()).toEqual({ dry_run: true, would: 'forget the model\'s ja translation "T:Save"' });
    expect(rows()).toHaveLength(1);
    const r = await act("retranslate", { app: "shop", text: "Save", lang: "ja", reason: "owner says it reads wrong" }, "k1");
    expect(r.statusCode).toBe(200);
    expect(rows()).toHaveLength(0);
    // Same key: the first answer, not a 409 for the row that is gone.
    expect((await act("retranslate", { app: "shop", text: "Save", lang: "ja", reason: "again" }, "k1")).json()).toEqual(r.json());
    expect(db.prepare("SELECT name, reason, status FROM ops_actions").all()).toEqual([{ name: "retranslate", reason: "owner says it reads wrong", status: 200 }]);
    // The app holds the limit too.
    for (let i = 0; i < 19; i++) db.prepare("INSERT INTO ops_actions (name, params, status, body) VALUES ('retranslate', '{}', 200, '{}')").run();
    await translate(["Save"]);
    expect((await act("retranslate", { app: "shop", text: "Save", lang: "ja", reason: "r" })).json().error).toMatch(/its limit/);
  });

  it("reload_glossary: 409 without a file, when it is invalid or already matches; dry run; run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lingo-"));
    const file = join(dir, "glossary.json");
    expect((await setup().act("reload_glossary", { reason: "r" })).json()).toEqual({ error: "no glossary file is configured (LINGO_GLOSSARY)" });
    const { db, act } = setup({ glossaryFile: file });
    writeFileSync(file, "{not json");
    expect((await act("reload_glossary", { reason: "r" })).json().error).toMatch(/cannot be used/);
    writeFileSync(file, JSON.stringify([{ term: "lingo", rule: "keep" }, { term: "lingo", rule: "keep" }]));
    expect((await act("reload_glossary", { reason: "r" })).json().error).toMatch(/twice/);
    setEntries(db, "*", [{ term: "lingo", rule: "keep" }, { term: "old", rule: "keep" }]);
    writeFileSync(file, JSON.stringify([{ term: "lingo", rule: "keep" }, { term: "ingest", rule: "fixed", to: { ja: "取り込み" } }]));
    expect((await act("reload_glossary", { reason: "r", dry_run: true })).json()).toEqual({ dry_run: true, would: "replace the global glossary with the file's 2 entries: add ingest; remove old" });
    expect(db.prepare("SELECT term FROM glossary ORDER BY term").all()).toEqual([{ term: "lingo" }, { term: "old" }]);
    expect((await act("reload_glossary", { reason: "file edited" })).statusCode).toBe(200);
    expect(db.prepare("SELECT term FROM glossary ORDER BY term").all()).toEqual([{ term: "ingest" }, { term: "lingo" }]);
    expect((await act("reload_glossary", { reason: "r" })).json()).toEqual({ error: "the database already matches the file" });
  });
});
