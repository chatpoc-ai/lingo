import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp } from "../src/server.ts";
import { createClient } from "../src/client.ts";
import type { Chat } from "../src/llm.ts";

const seen: Array<{ text: string; context?: string }> = [];
const chat: Chat = async (_m, msgs) => {
  const items = (JSON.parse(msgs[1]!.content) as { items: Array<{ text: string; context?: string }> }).items;
  seen.push(...items);
  return JSON.stringify({ translations: items.map((i) => `T:${i.text}`) });
};

function setup() {
  const cfg = { ...loadConfig({}), db: ":memory:", langs: ["en", "zh-Hans", "ja"], opsToken: "ops-secret" };
  const db = openDb(":memory:");
  db.prepare("INSERT INTO tokens (hash, app) VALUES (?, 'ops')").run(createHash("sha256").update("tok").digest("hex"));
  return buildApp(cfg, db, chat);
}
const auth = { authorization: "Bearer tok" };

describe("server", () => {
  it("translates for a token's app, refuses without one and for unknown languages", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "POST", url: "/v1/translate", payload: { to: "ja", texts: ["a"] } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/translate", headers: auth, payload: { to: "de", texts: ["a"] } })).json().error).toMatch(/unsupported language de/);
    const r = await app.inject({ method: "POST", url: "/v1/translate", headers: auth, payload: { to: "zh-CN", texts: ["a", { text: "Home", kind: "name" }] } });
    expect(r.json()).toEqual({ translations: [{ text: "T:a", source: "model" }, { text: "T:Home", source: "model" }] });
    expect((await app.inject({ url: "/v1/languages" })).json()).toEqual({ languages: ["en", "zh-Hans", "ja"], source: "en" });
  });

  it("builds catalogs, keeps a person's correction, and has a glossary per app", async () => {
    const { app } = setup();
    await app.inject({ method: "PUT", url: "/v1/memory", headers: auth, payload: { to: "ja", text: "fold", translation: "折りたたむ" } });
    const c = await app.inject({ method: "POST", url: "/v1/catalog", headers: auth, payload: { to: ["ja", "zh-Hans"], entries: { fold: "fold", parts: "{n} parts" } } });
    expect(seen.find((i) => i.text === "{n} parts")!.context).toBe("key: parts"); // the key tells the model what a label is for
    expect(c.json()).toEqual({ catalogs: { ja: { fold: "折りたたむ", parts: "T:{n} parts" }, "zh-Hans": { fold: "T:fold", parts: "T:{n} parts" } }, missing: { ja: [], "zh-Hans": [] } });
    await app.inject({ method: "PUT", url: "/v1/glossary", headers: auth, payload: { entries: [{ term: "ingest", rule: "keep" }] } });
    expect((await app.inject({ url: "/v1/glossary", headers: auth })).json()).toEqual({ entries: [{ term: "ingest", rule: "keep", to: {} }] });
    expect((await app.inject({ url: "/v1/memory?q=fold&lang=ja", headers: auth })).json().rows[0]).toMatchObject({ source: "fold", text: "折りたたむ", origin: "human" });
  });

  it("answers a monitor behind its own token", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/ops/health" })).statusCode).toBe(404);
    const h = (await app.inject({ url: "/ops/health", headers: { authorization: "Bearer ops-secret" } })).json();
    expect(h.app).toBe("lingo");
    expect(h.checks.map((c: { id: string }) => c.id)).toEqual(["db", "model", "failures", "queue"]);
    const m = (await app.inject({ url: "/ops/manifest", headers: { authorization: "Bearer ops-secret" } })).json();
    expect(m.components.map((c: { id: string }) => c.id)).toEqual(["api", "memory", "model"]);
    expect((await app.inject({ url: "/ops/metrics", headers: { authorization: "Bearer ops-secret" } })).body).toContain("lingo_model_calls_total");
  });

  it("the client gives the source texts back when lingo is down, and caches what it got", async () => {
    const { app } = setup();
    let calls = 0;
    const via = (async (url: string, init?: RequestInit) => {
      calls++;
      const r = await app.inject({ method: (init?.method as "POST") ?? "GET", url: new URL(url).pathname, headers: init?.headers as Record<string, string>, payload: init?.body as string });
      return new Response(r.body, { status: r.statusCode });
    }) as typeof fetch;
    const c = createClient({ url: "http://lingo", token: "tok", fetch: via });
    expect(await c.translate(["a", "b"], "ja")).toEqual(["T:a", "T:b"]);
    expect(await c.translate(["a"], "ja")).toEqual(["T:a"]);
    expect(calls).toBe(1);
    const down = createClient({ url: "http://lingo", token: "tok", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    expect(await down.translate(["a"], "ja")).toEqual(["a"]);
  });
});
