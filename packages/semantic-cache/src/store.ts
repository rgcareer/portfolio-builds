// SQLite-backed cache store (node:sqlite — no native module needed). One row per cached
// entry plus an append-only events log for every lookup decision. The database is a
// runtime artifact only (gitignored *.db*/*.sqlite*; see .gitignore and conventions.md) —
// never committed — which is why, unlike every other committed record in this repo, an
// entry's raw `text` is kept alongside its hash: the guard tier (src/guards.ts) needs the
// literal text of the best-matching candidate to veto a near-miss at lookup time, and
// nothing here ever reaches git.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface Namespace {
  tenant: string;
  model: string;
  systemSha256: string;
  mock: boolean;
}

export interface EntryUsage {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
}

export interface NewEntry {
  tenant: string;
  model: string;
  systemSha256: string;
  mock: boolean;
  exactKey: string;
  text: string;
  textSha256: string;
  textChars: number;
  embedding: Float32Array;
  response: string;
  usage: EntryUsage | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface StoredEntry extends NewEntry {
  id: string;
  hits: number;
  lastHitAt: string | null;
}

export type CacheDecision = 'hit' | 'miss' | 'bypass';

export interface NewEvent {
  ts: string;
  tenant: string;
  model: string;
  decision: CacheDecision;
  reason: string;
  similarity: number | null;
  matchedId: string | null;
  exactKey: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id             TEXT PRIMARY KEY,
  tenant         TEXT NOT NULL,
  model          TEXT NOT NULL,
  system_sha256  TEXT NOT NULL,
  mock           INTEGER NOT NULL DEFAULT 0 CHECK (mock IN (0,1)),
  exact_key      TEXT NOT NULL,
  text           TEXT NOT NULL,
  text_sha256    TEXT NOT NULL,
  text_chars     INTEGER NOT NULL,
  embedding      BLOB NOT NULL,
  response       TEXT NOT NULL,
  usage_json     TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  hits           INTEGER NOT NULL DEFAULT 0,
  last_hit_at    TEXT,
  UNIQUE(tenant, model, system_sha256, mock, exact_key)
);
CREATE INDEX IF NOT EXISTS entries_ns ON entries(tenant, model, system_sha256, mock);
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  tenant      TEXT NOT NULL,
  model       TEXT NOT NULL,
  decision    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  similarity  REAL,
  matched_id  TEXT,
  exact_key   TEXT
);
`;

interface EntryRow {
  id: string;
  tenant: string;
  model: string;
  system_sha256: string;
  mock: number;
  exact_key: string;
  text: string;
  text_sha256: string;
  text_chars: number;
  embedding: Uint8Array;
  response: string;
  usage_json: string | null;
  created_at: string;
  expires_at: string | null;
  hits: number;
  last_hit_at: string | null;
}

function bytesToFloat32Array(bytes: Uint8Array): Float32Array {
  // Copy into a fresh, aligned buffer: the Uint8Array node:sqlite hands back may not be
  // 4-byte-aligned within its underlying ArrayBuffer.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

function float32ArrayToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function rowToEntry(row: EntryRow): StoredEntry {
  return {
    id: row.id,
    tenant: row.tenant,
    model: row.model,
    systemSha256: row.system_sha256,
    mock: row.mock === 1,
    exactKey: row.exact_key,
    text: row.text,
    textSha256: row.text_sha256,
    textChars: row.text_chars,
    embedding: bytesToFloat32Array(row.embedding),
    response: row.response,
    usage: row.usage_json ? (JSON.parse(row.usage_json) as EntryUsage) : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hits: row.hits,
    lastHitAt: row.last_hit_at,
  };
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string = ':memory:') {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  insertEntry(e: NewEntry): StoredEntry {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO entries (id,tenant,model,system_sha256,mock,exact_key,text,text_sha256,text_chars,embedding,response,usage_json,created_at,expires_at,hits,last_hit_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL)`,
      )
      .run(
        id,
        e.tenant,
        e.model,
        e.systemSha256,
        e.mock ? 1 : 0,
        e.exactKey,
        e.text,
        e.textSha256,
        e.textChars,
        float32ArrayToBuffer(e.embedding),
        e.response,
        e.usage ? JSON.stringify(e.usage) : null,
        e.createdAt,
        e.expiresAt,
      );
    return { ...e, id, hits: 0, lastHitAt: null };
  }

  getByExactKey(ns: Namespace, exactKey: string): StoredEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM entries WHERE tenant=? AND model=? AND system_sha256=? AND mock=? AND exact_key=?`)
      .get(ns.tenant, ns.model, ns.systemSha256, ns.mock ? 1 : 0, exactKey) as unknown as EntryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Non-expired entries in a namespace, as of `nowIso`. */
  listNamespace(ns: Namespace, nowIso: string): StoredEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM entries WHERE tenant=? AND model=? AND system_sha256=? AND mock=? AND (expires_at IS NULL OR expires_at > ?)`)
      .all(ns.tenant, ns.model, ns.systemSha256, ns.mock ? 1 : 0, nowIso) as unknown as EntryRow[];
    return rows.map(rowToEntry);
  }

  touchHit(id: string, nowIso: string): void {
    this.db.prepare(`UPDATE entries SET hits = hits + 1, last_hit_at = ? WHERE id = ?`).run(nowIso, id);
  }

  /** Deletes expired entries (globally, or scoped to one namespace). Returns the count removed. */
  purgeExpired(nowIso: string, ns?: Namespace): number {
    const r = ns
      ? this.db
          .prepare(`DELETE FROM entries WHERE tenant=? AND model=? AND system_sha256=? AND mock=? AND expires_at IS NOT NULL AND expires_at <= ?`)
          .run(ns.tenant, ns.model, ns.systemSha256, ns.mock ? 1 : 0, nowIso)
      : this.db.prepare(`DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(nowIso);
    return Number(r.changes);
  }

  /** Evicts the least-recently-used entries in `ns` until it holds at most `maxEntries`. */
  enforceLru(ns: Namespace, maxEntries: number): number {
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM entries WHERE tenant=? AND model=? AND system_sha256=? AND mock=?`)
      .get(ns.tenant, ns.model, ns.systemSha256, ns.mock ? 1 : 0) as { c: number };
    const over = countRow.c - maxEntries;
    if (over <= 0) return 0;
    const victims = this.db
      .prepare(
        `SELECT id FROM entries WHERE tenant=? AND model=? AND system_sha256=? AND mock=?
         ORDER BY COALESCE(last_hit_at, created_at) ASC LIMIT ?`,
      )
      .all(ns.tenant, ns.model, ns.systemSha256, ns.mock ? 1 : 0, over) as { id: string }[];
    for (const v of victims) this.db.prepare(`DELETE FROM entries WHERE id = ?`).run(v.id);
    return victims.length;
  }

  recordEvent(ev: NewEvent): void {
    this.db
      .prepare(`INSERT INTO events (id,ts,tenant,model,decision,reason,similarity,matched_id,exact_key) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), ev.ts, ev.tenant, ev.model, ev.decision, ev.reason, ev.similarity, ev.matchedId, ev.exactKey);
  }

  /** Total entry count, optionally scoped to one namespace (includes expired rows). */
  countEntries(ns?: Namespace): number {
    const r = ns
      ? (this.db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE tenant=? AND model=? AND system_sha256=? AND mock=?`).get(ns.tenant, ns.model, ns.systemSha256, ns.mock ? 1 : 0) as { c: number })
      : (this.db.prepare(`SELECT COUNT(*) AS c FROM entries`).get() as { c: number });
    return r.c;
  }

  countEvents(decision?: CacheDecision): number {
    const r = decision
      ? (this.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE decision = ?`).get(decision) as { c: number })
      : (this.db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number });
    return r.c;
  }

  close(): void {
    this.db.close();
  }
}
