import { DatabaseSync } from "node:sqlite";

/**
 * One SQLite file. The memory is keyed by (app, sha256 of the source text, source language, target
 * language): an app's sentence is translated once per language and reused everywhere it appears.
 */

const MIGRATIONS = [
  `CREATE TABLE memory (
     app        TEXT NOT NULL,
     hash       TEXT NOT NULL,        -- sha256 of the trimmed source text
     from_lang  TEXT NOT NULL,
     lang       TEXT NOT NULL,
     source     TEXT NOT NULL DEFAULT '', -- the source text itself (empty for rows imported by hash)
     text       TEXT NOT NULL,        -- the translation
     origin     TEXT NOT NULL,        -- model | human | import
     terms      TEXT NOT NULL DEFAULT '', -- hash of the glossary entries that applied when it was made
     model      TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     used_at    TEXT NOT NULL DEFAULT (datetime('now')),
     uses       INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (app, hash, from_lang, lang)
   )`,
  `CREATE TABLE glossary (
     scope  TEXT NOT NULL,            -- an app, or '*' for every app
     term   TEXT NOT NULL,
     rule   TEXT NOT NULL,            -- keep | fixed
     tr     TEXT NOT NULL DEFAULT '{}', -- {lang: translation} for fixed
     note   TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (scope, term)
   )`,
  `CREATE TABLE tokens (
     hash       TEXT PRIMARY KEY,     -- sha256 of the token
     app        TEXT NOT NULL,
     note       TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE usage (
     day    TEXT NOT NULL,
     app    TEXT NOT NULL,
     lang   TEXT NOT NULL,
     hits   INTEGER NOT NULL DEFAULT 0,
     made   INTEGER NOT NULL DEFAULT 0,
     failed INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, app, lang)
   )`,
  // A person has looked at it: corrections and imports count as looked at; the model's wait in the review queue.
  `ALTER TABLE memory ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0;
   UPDATE memory SET reviewed = 1 WHERE origin IN ('human', 'import')`,
  // Actions run through /ops/actions: the log, and the answers kept for an Idempotency-Key (24 h).
  `CREATE TABLE ops_actions (
     at     TEXT NOT NULL DEFAULT (datetime('now')),
     name   TEXT NOT NULL,
     params TEXT NOT NULL,            -- JSON
     reason TEXT NOT NULL DEFAULT '',
     key    TEXT,                     -- the Idempotency-Key of a run that may be answered again
     status INTEGER NOT NULL,
     body   TEXT NOT NULL             -- the JSON answer
   );
   CREATE UNIQUE INDEX ops_actions_key ON ops_actions (key) WHERE key IS NOT NULL`,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[i]!);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec("COMMIT");
  }
  return db;
}
