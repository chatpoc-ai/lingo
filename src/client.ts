/**
 * The client for apps: copy this file, or import it. It never throws: when lingo is slow or down, the
 * source texts come back, so a page shows its own language instead of an error. Translations already
 * fetched are kept in the process for a while.
 */

export interface ClientItem {
  text: string;
  context?: string;
  kind?: "text" | "name";
}

export interface ClientOptions {
  /** lingo's base URL, e.g. http://127.0.0.1:8790 */
  url: string;
  token: string;
  /** How long a call may take before the source texts are used, ms. */
  timeoutMs?: number;
  /** How long a translation is kept in the process, ms. */
  cacheMs?: number;
  fetch?: typeof fetch;
}

export interface Client {
  /** Translations in the same order as the texts; the source text where there is none (yet). */
  translate(texts: Array<string | ClientItem>, to: string, opts?: { from?: string; wait?: number }): Promise<string[]>;
  /** The supported languages (cached). */
  languages(): Promise<string[]>;
}

export function createClient(o: ClientOptions): Client {
  const f = o.fetch ?? fetch;
  const base = o.url.replace(/\/+$/, "");
  const cache = new Map<string, { text: string; until: number }>();
  const ttl = o.cacheMs ?? 10 * 60_000;
  let langs: { list: string[]; until: number } | null = null;
  const keyOf = (to: string, from: string, t: string) => `${from}\u0000${to}\u0000${t}`;

  return {
    async translate(texts, to, opts = {}) {
      const items = texts.map((t) => (typeof t === "string" ? { text: t } : t));
      const from = opts.from ?? "";
      const now = Date.now();
      const out = items.map((i) => cache.get(keyOf(to, from, i.text)));
      const todo = items.map((i, n) => ({ i, n })).filter(({ n }) => !out[n] || out[n]!.until < now);
      if (todo.length) {
        // lingo takes 100 texts a call.
        for (let k = 0; k < todo.length; k += 100) {
          const part = todo.slice(k, k + 100);
          try {
            const res = await f(`${base}/v1/translate`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${o.token}` },
              body: JSON.stringify({ to, ...(opts.from ? { from: opts.from } : {}), texts: part.map((p) => p.i), wait: opts.wait ?? Math.max(0, (o.timeoutMs ?? 8000) - 1000) }),
              signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
            });
            if (!res.ok) continue;
            const body = (await res.json()) as { translations?: Array<{ text: string; pending?: boolean; source?: string }> };
            part.forEach((p, j) => {
              const t = body.translations?.[j];
              if (!t) return;
              // Pending or untranslated: show it now, ask again next time.
              const final = !t.pending && t.source !== "original";
              const entry = { text: t.text, until: final ? now + ttl : 0 };
              if (final) cache.set(keyOf(to, from, p.i.text), entry);
              out[p.n] = entry;
            });
          } catch {
            /* lingo unreachable: the source texts are used */
          }
        }
      }
      return items.map((i, n) => out[n]?.text ?? i.text);
    },
    async languages() {
      if (langs && langs.until > Date.now()) return langs.list;
      try {
        const res = await f(`${base}/v1/languages`, { signal: AbortSignal.timeout(o.timeoutMs ?? 8000) });
        const body = (await res.json()) as { languages: string[] };
        langs = { list: body.languages, until: Date.now() + ttl };
        return body.languages;
      } catch {
        return langs?.list ?? [];
      }
    },
  };
}

export { normalize, pick } from "./lang.ts";
