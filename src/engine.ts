import { createHash } from "node:crypto";
import { textProblems } from "./checks.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { entriesOf, glossaryProblems, promptLines, relevant, termsHash, type Entry } from "./glossary.ts";
import { languageName } from "./lang.ts";
import { jsonIn, type Chat } from "./llm.ts";

/**
 * Translation with a memory. A text is looked up by (app, hash, from, to); what is missing goes to
 * the model in batches, is checked (placeholders, numbers, glossary), retried once with what was
 * wrong, and kept. A caller that cannot wait gets the source text back at once, marked pending,
 * and the translation is there the next time. The same text asked for twice at once is made once.
 */

export interface Item {
  text: string;
  /** Where the text appears; helps the model, is not part of the memory's key. */
  context?: string;
  /** "name": a name of a place, machine, product or part, where proper nouns stay as they are. */
  kind?: "text" | "name";
}

export interface Result {
  text: string;
  /** memory: made before; human: set by a person; model: made now; original: could not be had; same: no translation needed. */
  source: "memory" | "human" | "model" | "original" | "same";
  /** Still being made: ask again later. */
  pending?: boolean;
}

export interface Options {
  from?: string;
  /** How long to wait for the model, in ms; what is not done by then comes back pending. */
  wait?: number;
  /** Building a catalog: the careful model, bigger batches. */
  catalog?: boolean;
}

export const hashOf = (text: string) => createHash("sha256").update(text.trim()).digest("hex");

interface Row {
  text: string;
  origin: string;
  terms: string;
}

const BATCH = 20, CATALOG_BATCH = 40;

export interface Stats {
  calls: number;
  failedCalls: number;
  lastError: string;
  lastErrorAt: number;
  lastOkAt: number;
}

export function createEngine(db: Db, chat: Chat, cfg: Pick<Config, "llm" | "sourceLang">) {
  const inflight = new Map<string, Promise<string | null>>();
  const stats: Stats = { calls: 0, failedCalls: 0, lastError: "", lastErrorAt: 0, lastOkAt: 0 };
  const lookup = db.prepare("SELECT text, origin, terms FROM memory WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ?");
  const touch = db.prepare("UPDATE memory SET used_at = datetime('now'), uses = uses + 1 WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ?");
  const save = db.prepare(`INSERT INTO memory (app, hash, from_lang, lang, source, text, origin, terms, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (app, hash, from_lang, lang) DO UPDATE SET source = excluded.source, text = excluded.text, origin = excluded.origin, terms = excluded.terms, model = excluded.model, created_at = datetime('now')
    WHERE memory.origin <> 'human' OR excluded.origin = 'human'`);
  const count = (app: string, lang: string, col: "hits" | "made" | "failed", n: number) => {
    if (n) db.prepare(`INSERT INTO usage (day, app, lang, ${col}) VALUES (date('now'), ?, ?, ?) ON CONFLICT (day, app, lang) DO UPDATE SET ${col} = ${col} + excluded.${col}`).run(app, lang, n);
  };

  /** One model call for a batch; the translations in order, null where the answer was unusable. */
  async function ask(items: Array<Item & { entries: Entry[] }>, from: string, to: string, model: string, problems?: string[][]): Promise<Array<string | null>> {
    const entries = [...new Map(items.flatMap((i) => i.entries).map((e) => [e.term, e])).values()];
    const system = [
      `You translate text for software from ${languageName(from)} into ${languageName(to)}.`,
      "- Translate each item's \"text\". \"context\" only says where it appears; do not translate it.",
      "- Keep exactly as they are: placeholders like {n}, %s or {{name}}, text in backticks, URLs, numbers, HTML tags, file paths, and identifiers (snake_case, dotted.names, CamelCase).",
      "- Items of kind \"name\" are names of places, machines, products or parts: keep proper nouns and product names, translate only the common words.",
      "- Keep the tone and roughly the length. Do not explain, add or leave out anything.",
      ...(entries.length ? ["Glossary:", ...promptLines(entries, to)] : []),
      'Answer with JSON only: {"translations": ["…", …]}, one string per item, in the same order.',
    ].join("\n");
    const payload = { items: items.map((i, n) => ({ text: i.text.trim(), ...(i.context ? { context: i.context } : {}), ...(i.kind === "name" ? { kind: "name" } : {}), ...(problems?.[n]?.length ? { fix: problems[n] } : {}) })) };
    stats.calls++;
    let answer: string;
    try {
      answer = await chat(model, [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }]);
      stats.lastOkAt = Date.now();
    } catch (err) {
      stats.failedCalls++;
      stats.lastError = (err as Error).message;
      stats.lastErrorAt = Date.now();
      return items.map(() => null);
    }
    try {
      const out = jsonIn<{ translations?: unknown[] }>(answer).translations;
      if (!Array.isArray(out) || out.length !== items.length) return items.map(() => null);
      return out.map((t) => (typeof t === "string" ? t : null));
    } catch {
      return items.map(() => null);
    }
  }

  /** Makes, checks, retries once, keeps. Resolves each item's promise with the translation or null. */
  async function make(app: string, jobs: Array<{ key: string; item: Item; entries: Entry[]; terms: string; done: (t: string | null) => void }>, from: string, to: string, opts: Options) {
    const model = opts.catalog ? cfg.llm.catalogModel : cfg.llm.model;
    const size = opts.catalog ? CATALOG_BATCH : BATCH;
    for (let i = 0; i < jobs.length; i += size) {
      const batch = jobs.slice(i, i + size);
      const first = await ask(batch.map((j) => ({ ...j.item, entries: j.entries })), from, to, model);
      const issues = batch.map((j, n) => (first[n] == null ? ["no answer"] : [...textProblems(j.item.text, first[n]!), ...glossaryProblems(j.entries, first[n]!, to)]));
      const again = batch.map((_, n) => n).filter((n) => issues[n]!.length);
      const second = again.length ? await ask(again.map((n) => ({ ...batch[n]!.item, entries: batch[n]!.entries })), from, to, model, again.map((n) => issues[n]!)) : [];
      let made = 0, failed = 0;
      batch.forEach((j, n) => {
        let t: string | null = issues[n]!.length ? null : first[n]!;
        const k = again.indexOf(n);
        if (k >= 0) {
          const s = second[k];
          t = s != null && !textProblems(j.item.text, s).length && !glossaryProblems(j.entries, s, to).length ? s : null;
        }
        if (t != null) {
          save.run(app, hashOf(j.item.text), from, to, j.item.text.trim(), t.trim(), "model", j.terms, model);
          made++;
        } else failed++;
        j.done(t?.trim() ?? null);
      });
      count(app, to, "made", made);
      count(app, to, "failed", failed);
    }
  }

  async function translate(app: string, items: Item[], to: string, opts: Options = {}): Promise<Result[]> {
    const from = opts.from ?? cfg.sourceLang;
    if (from === to) return items.map((i) => ({ text: i.text, source: "same" }));
    const glossary = entriesOf(db, app);
    const results: Result[] = new Array(items.length);
    const waits: Array<{ n: number; promise: Promise<string | null>; fallback: string }> = [];
    const jobs: Parameters<typeof make>[1] = [];
    let hits = 0;
    items.forEach((item, n) => {
      const text = item.text ?? "";
      if (!text.trim()) return void (results[n] = { text, source: "same" });
      const hash = hashOf(text);
      const entries = relevant(glossary, text);
      const terms = termsHash(entries, to);
      const row = lookup.get(app, hash, from, to) as Row | undefined;
      // A model's translation made under other glossary entries is stale; a person's or an import never is.
      if (row && (row.origin !== "model" || row.terms === terms)) {
        touch.run(app, hash, from, to);
        hits++;
        return void (results[n] = { text: row.text, source: row.origin === "human" ? "human" : "memory" });
      }
      const key = `${app}\u0000${hash}\u0000${from}\u0000${to}\u0000${terms}`;
      let promise = inflight.get(key);
      if (!promise) {
        let done!: (t: string | null) => void;
        promise = new Promise<string | null>((r) => (done = r)).finally(() => inflight.delete(key));
        inflight.set(key, promise);
        jobs.push({ key, item, entries, terms, done });
      }
      waits.push({ n, promise, fallback: row?.text ?? text });
    });
    count(app, to, "hits", hits);
    if (jobs.length) void make(app, jobs, from, to, opts).catch(() => jobs.forEach((j) => j.done(null)));
    if (waits.length) {
      const settled = new Map<number, string | null>();
      const all = Promise.all(waits.map((w) => w.promise.then((t) => void settled.set(w.n, t))));
      await (opts.wait === undefined ? all : Promise.race([all, new Promise((r) => setTimeout(r, opts.wait).unref?.())]));
      for (const w of waits) {
        const t = settled.get(w.n);
        results[w.n] = t != null ? { text: t, source: "model" } : settled.has(w.n) ? { text: w.fallback, source: w.fallback === items[w.n]!.text ? "original" : "memory" } : { text: w.fallback, source: w.fallback === items[w.n]!.text ? "original" : "memory", pending: true };
      }
    }
    return results;
  }

  /** A person's translation: used from now on, never replaced by the model. */
  function setHuman(app: string, from: string, to: string, source: string, text: string) {
    save.run(app, hashOf(source), from, to, source.trim(), text.trim(), "human", "", "");
  }

  /** Translations made elsewhere, by the hash of their source (the source text is optional). */
  function importOne(app: string, from: string, to: string, hash: string, text: string, source = "") {
    db.prepare(`INSERT INTO memory (app, hash, from_lang, lang, source, text, origin) VALUES (?, ?, ?, ?, ?, ?, 'import') ON CONFLICT DO NOTHING`).run(app, hash, from, to, source, text);
  }

  return { translate, setHuman, importOne, stats, pending: () => inflight.size };
}

export type Engine = ReturnType<typeof createEngine>;
