// The cost ledger: one SQLite row per LLM call (success, failure, or mock), written by the
// gateway and read by every piece's cost section. Uses Node's built-in node:sqlite so the
// monorepo needs no native module. Persistence must never break generation, so every
// write is wrapped.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface CallRow {
  id: string;
  run_id: string | null;
  provider: string;
  model: string;
  purpose: string | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  cost_usd: number;
  mock: number;
  error: string | null;
  created_at: string;
}

export interface CallInsert {
  runId?: string | null;
  provider: string;
  model: string;
  purpose?: string | null;
  usage?: { input?: number; cacheRead?: number; cacheCreation?: number; output?: number } | null;
  costUsd: number;
  mock?: boolean;
  error?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  purpose               TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL DEFAULT 0,
  mock                  INTEGER NOT NULL DEFAULT 0 CHECK (mock IN (0,1)),
  error                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id);
`;

export class Ledger {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string = ':memory:') {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  insert(row: CallInsert): string | null {
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO calls (id, run_id, provider, model, purpose, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, cost_usd, mock, error)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          row.runId ?? null,
          row.provider,
          row.model,
          row.purpose ?? null,
          row.usage?.input ?? 0,
          row.usage?.cacheRead ?? 0,
          row.usage?.cacheCreation ?? 0,
          row.usage?.output ?? 0,
          row.costUsd,
          row.mock ? 1 : 0,
          row.error ?? null,
        );
      return id;
    } catch {
      return null; // persistence must never break generation
    }
  }

  /** Total real (non-mock) cost, optionally for one run. */
  totalCostUsd(runId?: string): number {
    const sql = runId
      ? 'SELECT COALESCE(SUM(cost_usd),0) AS c FROM calls WHERE mock = 0 AND run_id = ?'
      : 'SELECT COALESCE(SUM(cost_usd),0) AS c FROM calls WHERE mock = 0';
    const stmt = this.db.prepare(sql);
    const r = (runId ? stmt.get(runId) : stmt.get()) as { c: number };
    return r.c;
  }

  count(opts: { runId?: string; mock?: boolean; errorsOnly?: boolean } = {}): number {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.runId) {
      where.push('run_id = ?');
      args.push(opts.runId);
    }
    if (opts.mock !== undefined) {
      where.push('mock = ?');
      args.push(opts.mock ? 1 : 0);
    }
    if (opts.errorsOnly) where.push('error IS NOT NULL');
    const sql = `SELECT COUNT(*) AS n FROM calls${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const r = this.db.prepare(sql).get(...args) as { n: number };
    return r.n;
  }

  rows(runId?: string): CallRow[] {
    const sql = runId ? 'SELECT * FROM calls WHERE run_id = ? ORDER BY created_at, id' : 'SELECT * FROM calls ORDER BY created_at, id';
    const stmt = this.db.prepare(sql);
    return (runId ? stmt.all(runId) : stmt.all()) as unknown as CallRow[];
  }

  close(): void {
    this.db.close();
  }
}
