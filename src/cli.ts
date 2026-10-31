import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createEngine } from "./engine.ts";
import { loadGlossaryFile, setEntries, type Entry } from "./glossary.ts";
import { openAiChat } from "./llm.ts";

const HELP = `lingo <command>

On the machine lingo runs on (reads LINGO_DB and the rest from the environment / LINGO_ENV):
  token create --app <app> [--note <text>]   a token for an app; printed once
  token list
  glossary load <file.json> [--app <app>]    replace the global (or an app's) glossary
  import <file.jsonl> --app <app> --to <lang> [--from en]
                                             translations made elsewhere, one {"hash"|"source", "text"} per line

From anywhere, against a running lingo (LINGO_URL, LINGO_TOKEN):
  catalog <en.json> --to <lang,lang> --out <dir> [--context <text>]
                                             a flat {key: text} file into <dir>/<lang>.json for each language`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = (name: string) => flag(name) ?? (console.error(`--${name} is needed\n\n${HELP}`), process.exit(2));

async function main() {
  const [cmd, sub] = args;
  if (cmd === "catalog") {
    const url = process.env.LINGO_URL, token = process.env.LINGO_TOKEN;
    if (!url || !token) throw new Error("LINGO_URL and LINGO_TOKEN are needed");
    const entries = JSON.parse(readFileSync(sub!, "utf8")) as Record<string, string>;
    const res = await fetch(`${url.replace(/\/+$/, "")}/v1/catalog`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: need("to").split(","), entries, context: flag("context") }),
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { catalogs: Record<string, Record<string, string>>; missing: Record<string, string[]> };
    const out = need("out");
    mkdirSync(out, { recursive: true });
    for (const [lang, cat] of Object.entries(body.catalogs)) {
      writeFileSync(join(out, `${lang}.json`), `${JSON.stringify(cat, null, 2)}\n`);
      const miss = body.missing[lang] ?? [];
      console.log(`${lang}: ${Object.keys(cat).length} keys${miss.length ? `, ${miss.length} still in the source language: ${miss.slice(0, 10).join(", ")}${miss.length > 10 ? " …" : ""}` : ""}`);
    }
    return;
  }

  const cfg = loadConfig();
  const db = openDb(cfg.db);
  if (cmd === "token" && sub === "create") {
    const token = `lingo_${randomBytes(24).toString("base64url")}`;
    db.prepare("INSERT INTO tokens (hash, app, note) VALUES (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), need("app"), flag("note") ?? "");
    console.log(token);
  } else if (cmd === "token" && sub === "list") {
    for (const r of db.prepare("SELECT app, note, created_at, substr(hash, 1, 8) AS id FROM tokens ORDER BY app").all()) console.log(Object.values(r as object).join("\t"));
  } else if (cmd === "glossary" && sub === "load") {
    const file = args[2]!;
    const app = flag("app");
    if (app) setEntries(db, app, JSON.parse(readFileSync(file, "utf8")) as Entry[]);
    else loadGlossaryFile(db, file);
    console.log(`glossary for ${app ?? "every app"} loaded`);
  } else if (cmd === "import") {
    const engine = createEngine(db, openAiChat(cfg.llm), cfg);
    const app = need("app"), to = need("to"), from = flag("from") ?? cfg.sourceLang;
    let n = 0;
    for (const line of readFileSync(sub!, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { hash?: string; source?: string; text: string };
      const hash = r.hash ?? createHash("sha256").update((r.source ?? "").trim()).digest("hex");
      engine.importOne(app, from, to, hash, r.text, r.source ?? "");
      n++;
    }
    console.log(`${n} translations imported for ${app} (${from} → ${to})`);
  } else {
    console.log(HELP);
    process.exit(cmd ? 2 : 0);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
