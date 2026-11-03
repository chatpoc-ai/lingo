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
  /** The admin pages' port and the token they need (bearer, or a cookie set by ?token=); no port, no admin pages. */
  adminPort?: number;
  adminToken?: string;
  /** Bearer for /ops/* (health, metrics, manifest, tools, actions); without it those routes answer 404. */
  opsToken?: string;
  /** For /ops/manifest: the name of the app that serves the model, when it is one of the monitor's own. */
  llmApp?: string;
  /** For /ops/manifest: the host service that runs lingo (a systemd unit, a launchd label), for the monitor to watch. */
  service?: string;
  /** For /ops/manifest: the companies this deployment runs on and is reached through ("self" for your own machine). */
  providers: Provider[];
}

export const PROVIDER_KINDS = ["hosting", "edge", "dns", "mail", "storage", "registrar"] as const;
export interface Provider {
  kind: (typeof PROVIDER_KINDS)[number];
  name: string;
}

/** "hosting:self,edge:Cloudflare" → providers; a kind the contract does not know is an error, not a guess. */
export function parseProviders(spec: string | undefined): Provider[] {
  return (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((item) => {
    const i = item.indexOf(":");
    const kind = item.slice(0, i).trim(), name = item.slice(i + 1).trim();
    if (i < 0 || !name || !(PROVIDER_KINDS as readonly string[]).includes(kind)) throw new Error(`LINGO_PROVIDERS: "${item}" is not kind:name with kind one of ${PROVIDER_KINDS.join(", ")}`);
    return { kind: kind as Provider["kind"], name };
  });
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
    adminPort: env.LINGO_ADMIN_PORT ? Number(env.LINGO_ADMIN_PORT) : undefined,
    adminToken: env.LINGO_ADMIN_TOKEN || undefined,
    opsToken: env.OPS_TOKEN || undefined,
    llmApp: env.LINGO_LLM_APP || undefined,
    service: env.LINGO_SERVICE || undefined,
    providers: parseProviders(env.LINGO_PROVIDERS),
  };
}
