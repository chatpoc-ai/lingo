import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { setEntries, type Entry } from "./glossary.ts";
import { languageName } from "./lang.ts";

/**
 * The admin pages, on a port of their own: what the memory holds per app and language, the review
 * queue (what the model made and nobody has looked at), search and correct, the glossaries. Every
 * link and form is relative, so the pages work behind a proxy under any path (/lingo/ on a monitor).
 * A correction is a person's translation: it is used from then on and never replaced by the model.
 */

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const q = (o: Record<string, string | number | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

const CSS = `:root{--bg:#f6f7f9;--card:#fff;--fg:#17181c;--muted:#666d78;--line:#dde1e7;--accent:#2f5fd0;--warn:#a86b00;--ok:#1a8a52}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e6e8ec;--muted:#9aa3b2;--line:#2d323c;--accent:#7aa7ff;--warn:#f3b63a;--ok:#3ccb7f}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,"PingFang SC","Hiragino Sans",system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:12px max(16px,env(safe-area-inset-left));background:var(--card);border-bottom:1px solid var(--line)}header b{font-size:17px}header a{color:var(--muted);text-decoration:none}header a.on{color:var(--fg);font-weight:600}
main{max-width:1200px;margin:0 auto;padding:18px 16px 60px}h1{font-size:17px;margin:4px 0 12px}a{color:var(--accent)}.muted{color:var(--muted)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}.src{max-width:420px;overflow-wrap:anywhere}textarea{width:100%;min-width:220px;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);resize:vertical}
input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}button{font:inherit;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.tag{font-size:11px;padding:1px 6px;border-radius:5px;border:1px solid var(--line);color:var(--muted)}.tag.model{color:var(--warn)}.tag.human{color:var(--ok)}
form.inline{display:inline}.actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}.wrap{overflow-x:auto}`;

const page = (title: string, nav: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · lingo</title><style>${CSS}</style></head><body>
<header><b>lingo</b>${[["./", "Overview"], ["review", "Review"], ["memory", "Memory"], ["glossary", "Glossary"]].map(([h, l]) => `<a href="${h}"${nav === l ? ' class="on"' : ""}>${l}</a>`).join("")}</header><main>${body}</main></body></html>`;

interface Row {
  app: string;
  hash: string;
  from_lang: string;
  lang: string;
  source: string;
  text: string;
  origin: string;
  reviewed: number;
  used_at: string;
  uses: number;
}

/** One translation with what can be done to it: keep it as it is, correct it, or have it made again. */
const rowHtml = (r: Row, back: string) => {
  const keys = `<input type="hidden" name="app" value="${esc(r.app)}"><input type="hidden" name="hash" value="${esc(r.hash)}"><input type="hidden" name="from" value="${esc(r.from_lang)}"><input type="hidden" name="lang" value="${esc(r.lang)}"><input type="hidden" name="source" value="${esc(r.source)}"><input type="hidden" name="back" value="${esc(back)}">`;
  return `<tr id="${esc(r.hash.slice(0, 12))}-${esc(r.lang)}"><td class="src">${r.source ? esc(r.source) : '<span class="muted">(imported without its source)</span>'}<div class="muted" style="font-size:12px">${esc(r.app)} · ${esc(r.from_lang)} → ${esc(r.lang)} · <span class="tag ${esc(r.origin)}">${esc(r.origin)}${r.reviewed ? "" : ", not reviewed"}</span> · used ${r.uses}× · ${esc(r.used_at)}</div></td>
<td><form method="post" action="save">${keys}<textarea name="text" rows="${Math.min(6, Math.max(2, Math.ceil(r.text.length / 60)))}" lang="${esc(r.lang)}">${esc(r.text)}</textarea>
<div class="actions"><button class="primary">Save as correct</button>${r.reviewed ? "" : `<button formaction="approve">Looks right</button>`}${r.source ? `<button formaction="retranslate" title="Forget it; the model makes it again the next time it is asked for">Translate again</button>` : ""}</div></form></td></tr>`;
};

export function buildAdmin(cfg: Config, db: Db): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    const p = new URLSearchParams(body as string);
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of p) out[k] = k in out ? [...([] as string[]).concat(out[k]!), v] : v;
    done(null, out);
  });

  // The token as a bearer (a proxy in front), or once as ?token= which sets a cookie (a person).
  const want = cfg.adminToken ? createHash("sha256").update(cfg.adminToken).digest() : null;
  const ok = (given: string) => !!want && timingSafeEqual(createHash("sha256").update(given).digest(), want);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const cookie = /(?:^|;\s*)lingo_admin=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    const token = (req.query as { token?: string })?.token ?? "";
    if (token && ok(token)) {
      reply.header("set-cookie", `lingo_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      // Relative, like every link here, so it works behind a proxy under any path.
      const clean = req.url.replace(/([?&])token=[^&]*&?/, "$1").replace(/[?&]$/, "");
      return reply.redirect(clean.slice(clean.lastIndexOf("/", clean.indexOf("?") < 0 ? undefined : clean.indexOf("?")) + 1) || "./", 303);
    }
    if (!ok(bearer) && !ok(decodeURIComponent(cookie))) return reply.code(401).type("text/plain").send("lingo admin: a valid token is needed (Authorization: Bearer, or ?token= once)");
  });

  const apps = () => (db.prepare("SELECT DISTINCT app FROM memory UNION SELECT DISTINCT app FROM tokens ORDER BY 1").all() as Array<{ app: string }>).map((r) => r.app);
  const filters = (path: string, v: { app?: string; lang?: string; q?: string }, withQ = true) => `<form class="row" method="get" action="${path}">
<select name="app"><option value="">every app</option>${apps().map((a) => `<option${a === v.app ? " selected" : ""}>${esc(a)}</option>`).join("")}</select>
<select name="lang"><option value="">every language</option>${cfg.langs.filter((l) => l !== cfg.sourceLang).map((l) => `<option value="${esc(l)}"${l === v.lang ? " selected" : ""}>${esc(languageName(l))} (${esc(l)})</option>`).join("")}</select>
${withQ ? `<input name="q" value="${esc(v.q ?? "")}" placeholder="text in either language" size="30">` : ""}<button>Show</button></form>`;
  const where = (v: { app?: string; lang?: string; q?: string }, extra: string[] = []) => {
    const parts = [...extra], args: string[] = [];
    if (v.app) { parts.push("app = ?"); args.push(v.app); }
    if (v.lang) { parts.push("lang = ?"); args.push(v.lang); }
    if (v.q) { parts.push("(source LIKE ? OR text LIKE ?)"); args.push(`%${v.q}%`, `%${v.q}%`); }
    return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
  };

  app.get("/", async (_req, reply) => {
    const rows = db.prepare(`SELECT app, lang, count(*) AS n, sum(origin = 'human') AS human, sum(reviewed = 0) AS waiting FROM memory GROUP BY app, lang ORDER BY app, lang`).all() as Array<{ app: string; lang: string; n: number; human: number; waiting: number }>;
    const today = db.prepare(`SELECT app, lang, hits, made, failed FROM usage WHERE day = date('now') ORDER BY app, lang`).all() as Array<{ app: string; lang: string; hits: number; made: number; failed: number }>;
    const use = new Map(today.map((u) => [`${u.app}\u0000${u.lang}`, u]));
    return reply.type("text/html").send(page("Overview", "Overview", `<h1>What the memory holds</h1>
<div class="wrap"><table><tr><th>app</th><th>language</th><th class="num">translations</th><th class="num">corrected by a person</th><th class="num">waiting for review</th><th class="num">today: from memory / made / could not</th></tr>
${rows.map((r) => { const u = use.get(`${r.app}\u0000${r.lang}`); return `<tr><td>${esc(r.app)}</td><td>${esc(languageName(r.lang))} <span class="muted">${esc(r.lang)}</span></td><td class="num"><a href="memory?${q({ app: r.app, lang: r.lang })}">${r.n}</a></td><td class="num">${r.human}</td><td class="num">${r.waiting ? `<a href="review?${q({ app: r.app, lang: r.lang })}">${r.waiting}</a>` : "0"}</td><td class="num">${u ? `${u.hits} / ${u.made} / ${u.failed}` : ""}</td></tr>`; }).join("") || `<tr><td colspan="6" class="muted">Nothing translated yet.</td></tr>`}</table></div>`));
  });

  app.get<{ Querystring: { app?: string; lang?: string } }>("/review", async (req, reply) => {
    const v = req.query;
    const w = where(v, ["reviewed = 0"]);
    const rows = db.prepare(`SELECT * FROM memory ${w.sql} ORDER BY uses DESC, used_at DESC LIMIT 100`).all(...w.args) as unknown as Row[];
    const total = (db.prepare(`SELECT count(*) AS n FROM memory ${w.sql}`).get(...w.args) as { n: number }).n;
    const back = `review?${q({ app: v.app, lang: v.lang })}`;
    return reply.type("text/html").send(page("Review", "Review", `<h1>Made by the model, not looked at yet <span class="muted">(${total})</span></h1>
<p class="muted">Most used first. "Looks right" takes it out of this list; "Save as correct" keeps your words and locks them.</p>${filters("review", v, false)}
${rows.length ? `<form method="post" action="approve" class="row">${rows.map((r) => `<input type="hidden" name="key" value="${esc(`${r.app}\u0000${r.hash}\u0000${r.from_lang}\u0000${r.lang}`)}">`).join("")}<input type="hidden" name="back" value="${esc(back)}"><button>All ${rows.length} shown look right</button></form>` : ""}
<div class="wrap"><table><tr><th>source</th><th>translation</th></tr>${rows.map((r) => rowHtml(r, back)).join("") || `<tr><td colspan="2" class="muted">Nothing waiting.</td></tr>`}</table></div>`));
  });

  app.get<{ Querystring: { app?: string; lang?: string; q?: string; exact?: string } }>("/memory", async (req, reply) => {
    const v = req.query;
    // exact=1: one text, as a monitor links to it ("this translation is wrong").
    const w = v.exact && v.q ? { sql: `WHERE source = ?${v.app ? " AND app = ?" : ""}${v.lang ? " AND lang = ?" : ""}`, args: [v.q.trim(), ...(v.app ? [v.app] : []), ...(v.lang ? [v.lang] : [])] } : where(v);
    const rows = db.prepare(`SELECT * FROM memory ${w.sql} ORDER BY used_at DESC LIMIT 100`).all(...w.args) as unknown as Row[];
    const back = `memory?${q({ app: v.app, lang: v.lang, q: v.q, exact: v.exact })}`;
    return reply.type("text/html").send(page("Memory", "Memory", `<h1>Translations</h1>${filters("memory", v)}
<div class="wrap"><table><tr><th>source</th><th>translation</th></tr>${rows.map((r) => rowHtml(r, back)).join("") || `<tr><td colspan="2" class="muted">Nothing found${v.exact ? ": this text has not been translated yet; it will be the next time it is shown." : "."}</td></tr>`}</table></div>`));
  });

  app.get<{ Querystring: { app?: string } }>("/glossary", async (req, reply) => {
    const scope = req.query.app || "*";
    const own = db.prepare("SELECT term, rule, tr, note FROM glossary WHERE scope = ? ORDER BY term COLLATE NOCASE").all(scope) as Array<{ term: string; rule: string; tr: string; note: string }>;
    return reply.type("text/html").send(page("Glossary", "Glossary", `<h1>Glossary: ${scope === "*" ? "every app" : esc(scope)}</h1>
<form class="row" method="get" action="glossary"><select name="app"><option value="">every app (global)</option>${apps().map((a) => `<option${a === req.query.app ? " selected" : ""}>${esc(a)}</option>`).join("")}</select><button>Show</button></form>
<p class="muted">"keep": never translated (names, commands). "fixed": always this translation. An app's entries win over the global ones. Changing an entry has the translations that use it made again.</p>
<div class="wrap"><table><tr><th>term</th><th>rule</th><th>translations</th><th>note</th><th></th></tr>
${own.map((e) => `<tr><td>${esc(e.term)}</td><td>${esc(e.rule)}</td><td>${Object.entries(JSON.parse(e.tr) as Record<string, string>).map(([l, t]) => `${esc(l)}: ${esc(t)}`).join("<br>")}</td><td class="muted">${esc(e.note)}</td>
<td><form method="post" action="glossary/remove" class="inline"><input type="hidden" name="scope" value="${esc(scope)}"><input type="hidden" name="term" value="${esc(e.term)}"><button>Remove</button></form></td></tr>`).join("")}
<tr><td colspan="5"><form method="post" action="glossary/add" class="row" style="margin:0"><input type="hidden" name="scope" value="${esc(scope)}"><input name="term" placeholder="term" required><select name="rule"><option>keep</option><option>fixed</option></select>
<input name="to" placeholder="for fixed: ja=…; fr=…" size="34"><input name="note" placeholder="note" size="24"><button class="primary">Add</button></form></td></tr></table></div>`));
  });

  type Form = Record<string, string | string[] | undefined>;
  const one = (f: Form, k: string) => (Array.isArray(f[k]) ? (f[k] as string[])[0] : (f[k] as string | undefined)) ?? "";
  const backTo = (f: Form) => {
    const b = one(f, "back");
    // Only a page of ours: a relative path without a scheme or a leading slash.
    return /^(review|memory|glossary)(\?|$)/.test(b) ? b : "./";
  };

  app.post<{ Body: Form }>("/save", async (req, reply) => {
    const f = req.body ?? {};
    const text = one(f, "text").trim();
    if (text) {
      db.prepare("UPDATE memory SET text = ?, origin = 'human', reviewed = 1, created_at = datetime('now') WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ?").run(text, one(f, "app"), one(f, "hash"), one(f, "from"), one(f, "lang"));
    }
    return reply.redirect(backTo(f), 303);
  });
  app.post<{ Body: Form }>("/approve", async (req, reply) => {
    const f = req.body ?? {};
    const keys = f.key ? ([] as string[]).concat(f.key as string | string[]) : [`${one(f, "app")}\u0000${one(f, "hash")}\u0000${one(f, "from")}\u0000${one(f, "lang")}`];
    const st = db.prepare("UPDATE memory SET reviewed = 1 WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ?");
    for (const k of keys) {
      const [a, h, fr, l] = k.split("\u0000");
      if (a && h && fr && l) st.run(a, h, fr, l);
    }
    return reply.redirect(backTo(f), 303);
  });
  app.post<{ Body: Form }>("/retranslate", async (req, reply) => {
    const f = req.body ?? {};
    db.prepare("DELETE FROM memory WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ? AND source <> ''").run(one(f, "app"), one(f, "hash"), one(f, "from"), one(f, "lang"));
    return reply.redirect(backTo(f), 303);
  });
  app.post<{ Body: Form }>("/glossary/add", async (req, reply) => {
    const f = req.body ?? {};
    const scope = one(f, "scope") || "*", term = one(f, "term").trim(), rule = one(f, "rule") === "fixed" ? "fixed" : "keep";
    if (term) {
      const to = Object.fromEntries(one(f, "to").split(";").map((p) => p.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]) as Array<[string, string]>);
      const rest: Entry[] = (db.prepare("SELECT term, rule, tr, note FROM glossary WHERE scope = ?").all(scope) as Array<{ term: string; rule: Entry["rule"]; tr: string; note: string }>).map((e) => ({ term: e.term, rule: e.rule, to: JSON.parse(e.tr) as Record<string, string>, note: e.note || undefined }));
      setEntries(db, scope, [...rest.filter((e) => e.term.toLowerCase() !== term.toLowerCase()), { term, rule, to, note: one(f, "note") || undefined }]);
    }
    return reply.redirect(`../glossary${scope === "*" ? "" : `?${q({ app: scope })}`}`, 303);
  });
  app.post<{ Body: Form }>("/glossary/remove", async (req, reply) => {
    const f = req.body ?? {};
    db.prepare("DELETE FROM glossary WHERE scope = ? AND term = ?").run(one(f, "scope") || "*", one(f, "term"));
    const scope = one(f, "scope");
    return reply.redirect(`../glossary${scope && scope !== "*" ? `?${q({ app: scope })}` : ""}`, 303);
  });

  return app;
}
