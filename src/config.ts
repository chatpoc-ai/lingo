import { existsSync, readFileSync } from "node:fs";

/** Everything comes from the environment (and an optional env file); see .env.example. */
export interface Config {
  host: string;
  port: number;
  /** The SQLite file. ":memory:" for tests. */
  db: string;
  /** Supported languages, BCP 47; the source language of every app is `sourceLang` unless a request says otherwise. */
  langs: string[];
  sourceLang: string;
  llm: {
    /** An OpenAI-compatible base URL, ending before /chat/completions (…/v1). */
    url: string;
    key: string;
    /** The model for texts asked for at run time: fast. */
    model: string;
    /** The model for catalogs built ahead of time: careful. */
    catalogModel: string;
    /** "json_schema", "json_object" or "" (no response_format; the JSON is read from the text). */
    responseFormat: string;
    timeoutMs: number;
  };
  /** A JSON file with the global glossary, read at start-up (entries the API cannot change). */
  glossaryFile?: string;
  /** Bearer for /ops/health, /ops/metrics and /ops/manifest; without it those routes answer 404. */
  opsToken?: string;
  /** For /ops/manifest: the name of the app that serves the model, when it is one of the monitor's own. */
  llmApp?: string;
}

export function loadEnvFile(path: string, env: Record<string, string | undefined> = process.env) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  if (env === process.env && env.LINGO_ENV) loadEnvFile(env.LINGO_ENV, env);
  const model = env.LINGO_MODEL ?? "gpt-4o-mini";
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8790),
    db: env.LINGO_DB ?? "lingo.db",
    langs: (env.LINGO_LANGS ?? "en,zh-Hans,zh-Hant,ja").split(",").map((s) => s.trim()).filter(Boolean),
    sourceLang: env.LINGO_SOURCE_LANG ?? "en",
    llm: {
      url: (env.LINGO_LLM_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      key: env.LINGO_LLM_KEY ?? env.OPENAI_API_KEY ?? "",
      model,
      catalogModel: env.LINGO_CATALOG_MODEL ?? model,
      responseFormat: env.LINGO_RESPONSE_FORMAT ?? "",
      timeoutMs: Number(env.LINGO_LLM_TIMEOUT_MS ?? 60_000),
    },
    glossaryFile: env.LINGO_GLOSSARY || undefined,
    opsToken: env.OPS_TOKEN || undefined,
    llmApp: env.LINGO_LLM_APP || undefined,
  };
}
