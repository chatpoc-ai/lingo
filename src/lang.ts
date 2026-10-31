/**
 * Languages as BCP 47 tags. A tag the service supports is used as it is; anything else is mapped to
 * the nearest supported one (zh-TW → zh-Hant, zh-CN → zh-Hans, fr-CA → fr), or refused.
 */

/** How the model is told the language. Tags not listed are passed as they are. */
const NAMES: Record<string, string> = {
  en: "English",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  "pt-BR": "Brazilian Portuguese",
  nl: "Dutch",
  ru: "Russian",
  ar: "Arabic",
  vi: "Vietnamese",
  th: "Thai",
};

export const languageName = (tag: string) => NAMES[tag] ?? tag;

/** Chinese tags by script; the region decides when no script is given. */
const CHINESE: Record<string, string> = { tw: "zh-Hant", hk: "zh-Hant", mo: "zh-Hant", cn: "zh-Hans", sg: "zh-Hans", my: "zh-Hans" };

/** The supported tag for a requested one, or null. */
export function normalize(tag: string, supported: string[]): string | null {
  const t = tag.trim();
  if (!t) return null;
  const exact = supported.find((s) => s.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const parts = t.toLowerCase().split(/[-_]/);
  if (parts[0] === "zh") {
    const script = parts.find((p) => p === "hans" || p === "hant");
    const want = script ? `zh-${script === "hans" ? "Hans" : "Hant"}` : (CHINESE[parts[1] ?? ""] ?? "zh-Hans");
    return supported.find((s) => s === want) ?? supported.find((s) => s.toLowerCase().startsWith("zh")) ?? null;
  }
  return supported.find((s) => s.toLowerCase() === parts[0]) ?? supported.find((s) => s.toLowerCase().split("-")[0] === parts[0]) ?? null;
}

/** The viewer's language from an Accept-Language header, in the order of their preference. */
export function pick(acceptLanguage: string | undefined, supported: string[], fallback = supported[0] ?? "en"): string {
  const wanted = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.trim().slice(2) ?? 1);
      return { tag: tag!.trim(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const w of wanted) {
    const n = normalize(w.tag, supported);
    if (n) return n;
  }
  return fallback;
}
