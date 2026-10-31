import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";

/**
 * Terms that are never translated (product names, commands) and terms with a fixed translation.
 * Global entries apply to every app; an app's own entries win over global ones with the same term.
 */

export interface Entry {
  term: string;
  rule: "keep" | "fixed";
  /** For `fixed`: the translation by language. */
  to?: Record<string, string>;
  note?: string;
}

const isEntry = (e: unknown): e is Entry => !!e && typeof (e as Entry).term === "string" && ((e as Entry).rule === "keep" || (e as Entry).rule === "fixed");

/** The global glossary file: a JSON array of entries. Replaces the global entries in the database. */
export function loadGlossaryFile(db: Db, path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array of {term, rule, to?, note?}`);
  setEntries(db, "*", raw.filter(isEntry));
}

export function setEntries(db: Db, scope: string, entries: Entry[]) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM glossary WHERE scope = ?").run(scope);
    const ins = db.prepare("INSERT INTO glossary (scope, term, rule, tr, note) VALUES (?, ?, ?, ?, ?)");
    for (const e of entries.filter(isEntry)) ins.run(scope, e.term, e.rule, JSON.stringify(e.to ?? {}), e.note ?? "");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function entriesOf(db: Db, app: string): Entry[] {
  const rows = db.prepare("SELECT scope, term, rule, tr, note FROM glossary WHERE scope IN ('*', ?) ORDER BY scope = '*'").all(app) as Array<{ scope: string; term: string; rule: Entry["rule"]; tr: string; note: string }>;
  const out = new Map<string, Entry>();
  // The app's rows come first; a global row with the same term is shadowed.
  for (const r of rows) if (!out.has(r.term.toLowerCase())) out.set(r.term.toLowerCase(), { term: r.term, rule: r.rule, to: JSON.parse(r.tr) as Record<string, string>, note: r.note || undefined });
  return [...out.values()];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A term as a whole word (or, for CJK and symbols, as it is). */
const pattern = (term: string) => new RegExp(/^[\w]/.test(term) && /[\w]$/.test(term) ? `\\b${escape(term)}\\b` : escape(term), "i");

/** The entries a text mentions. */
export const relevant = (entries: Entry[], text: string) => entries.filter((e) => pattern(e.term).test(text));

/** A fingerprint of the entries that applied to a text in a language: when it changes, the translation is stale. */
export const termsHash = (entries: Entry[], lang: string) =>
  entries.length ? createHash("sha256").update(JSON.stringify(entries.map((e) => [e.term, e.rule, e.to?.[lang] ?? ""]).sort())).digest("hex").slice(0, 16) : "";

/** Lines for the prompt. */
export function promptLines(entries: Entry[], lang: string): string[] {
  return entries.map((e) => (e.rule === "keep" ? `- "${e.term}": keep as it is${e.note ? ` (${e.note})` : ""}` : e.to?.[lang] ? `- "${e.term}": always "${e.to[lang]}"` : `- "${e.term}": ${e.note ?? "a fixed term"}`));
}

/** What a translation got wrong about the glossary, empty when nothing. */
export function glossaryProblems(entries: Entry[], translation: string, lang: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    // Case may follow the sentence ("Ingest" at its start); the word itself must stay.
    if (e.rule === "keep" && !translation.toLowerCase().includes(e.term.toLowerCase())) out.push(`"${e.term}" must stay as it is`);
    if (e.rule === "fixed" && e.to?.[lang] && !translation.includes(e.to[lang])) out.push(`"${e.term}" must be "${e.to[lang]}"`);
  }
  return out;
}
