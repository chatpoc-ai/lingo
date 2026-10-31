import { describe, expect, it } from "vitest";
import { textProblems } from "../src/checks.ts";
import { openDb } from "../src/db.ts";
import { createEngine, hashOf } from "../src/engine.ts";
import { setEntries } from "../src/glossary.ts";
import { normalize, pick } from "../src/lang.ts";
import type { Chat, Message } from "../src/llm.ts";

const cfg = { sourceLang: "en", llm: { url: "", key: "", model: "fast", catalogModel: "careful", responseFormat: "", timeoutMs: 1000 } };
const itemsOf = (m: Message[]) => (JSON.parse(m[1]!.content) as { items: Array<{ text: string; fix?: string[] }> }).items;
/** A model that prefixes each text with the language it was asked for, and records its calls. */
const fakeModel = (calls: Array<{ model: string; messages: Message[] }>, tweak = (t: string, _i: { fix?: string[] }) => t): Chat => async (model, messages) => {
  calls.push({ model, messages });
  const lang = /into ([\w ]+)\./.exec(messages[0]!.content)![1]!;
  return `Here: {"translations": ${JSON.stringify(itemsOf(messages).map((i) => tweak(`[${lang}] ${i.text}`, i)))}}`;
};

describe("engine", () => {
  it("asks the model once for what it has not seen, keeps it, answers from the memory next time", async () => {
    const calls: Array<{ model: string; messages: Message[] }> = [];
    const e = createEngine(openDb(":memory:"), fakeModel(calls), cfg);
    const first = await e.translate("ops", [{ text: "{n} parts" }, { text: "Home", kind: "name", context: "a place" }, { text: "" }], "ja");
    expect(first).toEqual([{ text: "[Japanese] {n} parts", source: "model" }, { text: "[Japanese] Home", source: "model" }, { text: "", source: "same" }]);
    expect(calls).toHaveLength(1);
    expect(itemsOf(calls[0]!.messages)[1]).toEqual({ text: "Home", context: "a place", kind: "name" });
    const again = await e.translate("ops", [{ text: "{n} parts " }], "ja"); // trimmed: the same text
    expect(again).toEqual([{ text: "[Japanese] {n} parts", source: "memory" }]);
    expect(calls).toHaveLength(1);
    // Another app has its own memory; the same language asked as the source needs nothing.
    await e.translate("shop", [{ text: "{n} parts" }], "ja");
    expect(calls).toHaveLength(2);
    expect(await e.translate("ops", [{ text: "x" }], "en")).toEqual([{ text: "x", source: "same" }]);
  });

  it("makes a text asked for twice at once only once, and uses the careful model for catalogs", async () => {
    const calls: Array<{ model: string; messages: Message[] }> = [];
    const e = createEngine(openDb(":memory:"), fakeModel(calls), cfg);
    const [a, b] = await Promise.all([e.translate("ops", [{ text: "fold" }], "fr"), e.translate("ops", [{ text: "fold" }, { text: "fold" }], "fr")]);
    expect(a[0]!.text).toBe("[French] fold");
    expect(b.map((r) => r.text)).toEqual(["[French] fold", "[French] fold"]);
    expect(calls).toHaveLength(1);
    await e.translate("ops", [{ text: "open" }], "fr", { catalog: true });
    expect(calls[1]!.model).toBe("careful");
  });

  it("retries once with what was wrong, and gives the source back when it is still wrong", async () => {
    const calls: Array<{ model: string; messages: Message[] }> = [];
    // Loses the placeholder the first time; fixes it when told.
    const e = createEngine(openDb(":memory:"), fakeModel(calls, (t, i) => (i.fix ? t : t.replace("{n}", "N"))), cfg);
    expect(await e.translate("ops", [{ text: "{n} open" }], "ja")).toEqual([{ text: "[Japanese] {n} open", source: "model" }]);
    expect(itemsOf(calls[1]!.messages)[0]!.fix).toEqual(["placeholder {n} is missing"]);
    const stubborn = createEngine(openDb(":memory:"), fakeModel([], (t) => t.replace("713", "七百")), cfg);
    expect(await stubborn.translate("ops", [{ text: "713 of 1370 sites stale" }], "ja")).toEqual([{ text: "713 of 1370 sites stale", source: "original" }]);
  });

  it("keeps the glossary, and makes again what was made under other glossary entries", async () => {
    const db = openDb(":memory:");
    const calls: Array<{ model: string; messages: Message[] }> = [];
    const e = createEngine(db, fakeModel(calls, (t) => t.replace("heartbeat", "心跳")), cfg);
    setEntries(db, "*", [{ term: "heartbeat", rule: "fixed", to: { "zh-Hans": "心跳" } }, { term: "Workday", rule: "keep" }]);
    expect((await e.translate("ops", [{ text: "Workday heartbeat missed" }], "zh-Hans"))[0]).toEqual({ text: "[Simplified Chinese] Workday 心跳 missed", source: "model" });
    expect(calls[0]!.messages[0]!.content).toContain('- "heartbeat": always "心跳"');
    expect(calls[0]!.messages[0]!.content).toContain('- "Workday": keep as it is');
    expect((await e.translate("ops", [{ text: "no glossary words here" }], "zh-Hans"))[0]!.source).toBe("model");
    expect(calls[1]!.messages[0]!.content).not.toContain("Glossary:"); // only the entries a batch mentions
    // The app's own entry changes what "heartbeat" becomes: the old translation is stale.
    setEntries(db, "ops", [{ term: "heartbeat", rule: "keep" }]);
    const stale = createEngine(db, fakeModel(calls), cfg);
    expect((await stale.translate("ops", [{ text: "Workday heartbeat missed" }], "zh-Hans"))[0]!.text).toBe("[Simplified Chinese] Workday heartbeat missed");
  });

  it("a person's translation wins and is never replaced; an import is used as it is", async () => {
    const calls: Array<{ model: string; messages: Message[] }> = [];
    const e = createEngine(openDb(":memory:"), fakeModel(calls), cfg);
    e.setHuman("ops", "en", "zh-Hans", "Home", "家里");
    e.importOne("ops", "en", "zh-Hans", hashOf("system"), "系统");
    expect(await e.translate("ops", [{ text: "Home" }, { text: "system" }], "zh-Hans")).toEqual([{ text: "家里", source: "human" }, { text: "系统", source: "memory" }]);
    expect(calls).toHaveLength(0);
  });

  it("gives the source back at once when the caller cannot wait, and has the translation next time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: Array<{ model: string; messages: Message[] }> = [];
    const slow: Chat = async (m, msgs) => (await gate, fakeModel(calls)(m, msgs));
    const e = createEngine(openDb(":memory:"), slow, cfg);
    expect(await e.translate("ops", [{ text: "slow" }], "ko", { wait: 10 })).toEqual([{ text: "slow", source: "original", pending: true }]);
    expect(e.pending()).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(await e.translate("ops", [{ text: "slow" }], "ko", { wait: 10 })).toEqual([{ text: "[Korean] slow", source: "memory" }]);
  });

  it("survives a model that fails", async () => {
    const e = createEngine(openDb(":memory:"), async () => { throw new Error("HTTP 503"); }, cfg);
    expect(await e.translate("ops", [{ text: "x" }], "de")).toEqual([{ text: "x", source: "original" }]);
    expect(e.stats.lastError).toBe("HTTP 503");
  });
});

describe("checks and languages", () => {
  it("wants placeholders, code, URLs, tags and numbers carried over", () => {
    expect(textProblems("{n} parts at https://x.example/a in `ops.json`", "{n} 个部件 https://x.example/a `ops.json`")).toEqual([]);
    expect(textProblems("1,370 sites, 1.5 h", "1370 sites, 1,5 h")).toEqual([]);
    expect(textProblems("{n} <b>parts</b>", "部件")).toEqual(["placeholder {n} is missing", "tag <b> is missing", "tag </b> is missing"]);
    expect(textProblems("x", " ")).toEqual(["empty"]);
  });

  it("maps tags to the supported ones, and picks from Accept-Language", () => {
    const s = ["en", "zh-Hans", "zh-Hant", "ja", "fr"];
    expect(normalize("zh-TW", s)).toBe("zh-Hant");
    expect(normalize("zh", s)).toBe("zh-Hans");
    expect(normalize("zh-Hant-HK", s)).toBe("zh-Hant");
    expect(normalize("fr-CA", s)).toBe("fr");
    expect(normalize("JA", s)).toBe("ja");
    expect(normalize("de", s)).toBeNull();
    expect(pick("de-DE,de;q=0.9,fr;q=0.8,en;q=0.5", s)).toBe("fr");
    expect(pick("zh-HK,zh;q=0.9", s)).toBe("zh-Hant");
    expect(pick(undefined, s)).toBe("en");
  });
});
