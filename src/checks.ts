/**
 * What a translation must carry over from its source untouched: placeholders, code in backticks,
 * URLs, numbers, HTML tags, the targets of Markdown links. A translation that loses one is not used.
 */

const PATTERNS: Array<[string, RegExp]> = [
  ["placeholder", /\{[\w.]+\}|%\(\w+\)s|%[sd]|\$\{\w+\}|\{\{\s*[\w.]+\s*\}\}/g],
  ["code", /`[^`\n]+`/g],
  ["url", /\bhttps?:\/\/[^\s)<>"']+/g],
  ["tag", /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g],
  ["link", /\]\([^)\s]+\)/g],
];
/** Numbers as digits, ignoring grouping and the decimal mark (1,370 = 1370; 1.5 = 1,5 in French). */
const NUMBERS = /\d+(?:[.,]\d+)*/g;

const bag = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/** The problems with a translation, empty when it may be used. */
export function textProblems(source: string, translation: string): string[] {
  const out: string[] = [];
  const t = translation.trim();
  if (!t) return ["empty"];
  for (const [name, re] of PATTERNS) {
    const want = bag(source.match(re) ?? []);
    const got = bag(t.match(re) ?? []);
    for (const [x, n] of want) if ((got.get(x) ?? 0) < n) out.push(`${name} ${x} is missing`);
  }
  const digits = (s: string) => (s.match(NUMBERS) ?? []).map((n) => n.replace(/[.,]/g, "")).sort();
  const want = digits(source), got = digits(t);
  for (const n of new Set(want)) if (want.filter((x) => x === n).length > got.filter((x) => x === n).length) out.push(`number ${n} is missing`);
  // Long sources only: a two-word label may well triple in some languages.
  if (source.length > 40 && t.length > source.length * 4) out.push("far longer than the source");
  return out;
}
