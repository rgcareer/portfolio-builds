import Database from 'better-sqlite3';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/core/src
const SCHEMA_PATH = resolve(HERE, '..', 'db', 'schema.sql');
const MIGRATIONS_DIR = resolve(HERE, '..', 'db', 'migrations');

/**
 * Connection pragmas applied to every real handle. Ported from operation-hired:
 * busy_timeout makes a writer WAIT for the lock instead of throwing SQLITE_BUSY the
 * instant another writer (a resumed harvest, a WAL checkpoint) holds it.
 */
export function applyConnectionPragmas(db: Db): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

/** Apply the baseline schema (all M1 tables). Only on a brand-new database. */
export function applyBaselineSchema(db: Db): void {
  db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
}

/**
 * Apply numbered migrations from `migrationsDir` (NNN_name.sql), lexicographically,
 * each inside one transaction that also records its version row — a partial multi-
 * statement migration therefore cannot mark itself applied. Fails closed with the
 * offending filename prepended. Ported from operation-hired/server/db.js.
 */
export function runMigrations(db: Db, migrationsDir: string = MIGRATIONS_DIR): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);

  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  // schema.sql is the baseline (like OH). currentVersion 0 on a fresh DB lets a future
  // 001_*.sql apply; there are no migrations at M1.
  const currentVersion = current.v ?? 0;

  if (!existsSync(migrationsDir)) return;

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0] ?? '', 10);
    if (Number.isNaN(version) || version <= currentVersion) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    try {
      const migrate = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
      });
      migrate();
    } catch (err) {
      // Fail closed, diagnosably: name the culprit migration in the message.
      (err as Error).message = `Migration ${file} failed: ${(err as Error).message}`;
      throw err;
    }
  }
}

/** Initialize a fresh (file or in-memory) db: baseline schema + migrations. */
export function initializeSchema(db: Db): void {
  applyBaselineSchema(db);
  runMigrations(db);
}

/**
 * Open a database at `dbPath`, applying pragmas, baseline schema (if new), and any
 * migrations. Creates the parent directory if needed. This is the path CLIs use.
 */
export function openDb(dbPath: string): Db {
  const isNew = !existsSync(dbPath);
  if (isNew) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  applyConnectionPragmas(db);
  if (isNew) applyBaselineSchema(db);
  runMigrations(db);
  return db;
}

export function resolveDbPath(explicit?: string): string {
  return explicit ?? process.env.SKILLCHECK_DB_PATH ?? join(process.cwd(), 'data', 'skillcheck.db');
}

// --- Live singleton + test seams (ported from operation-hired) ---------------
let liveDb: Db | null = null;
let injectedTestDb: Db | null = null;

/** Vitest-only injection seam: point getDb() at an in-memory handle. */
export function injectTestDb(db: Db | null): void {
  if (!process.env.VITEST) {
    throw new Error('injectTestDb() is vitest-only — production code must never inject a DB.');
  }
  injectedTestDb = db;
}

/**
 * Get the process-wide live handle. Under vitest, refuses to open a real on-disk DB
 * unless a test injected one (or SKILLCHECK_ALLOW_LIVE_DB=1 for a deliberate
 * integration test) — a bare service call must never touch a real database in a unit test.
 */
export function getDb(explicitPath?: string): Db {
  if (process.env.VITEST && injectedTestDb) return injectedTestDb;
  if (liveDb) return liveDb;

  const dbPath = resolveDbPath(explicitPath);

  if (process.env.VITEST && !process.env.SKILLCHECK_ALLOW_LIVE_DB) {
    throw new Error(
      `getDb() attempted to open the LIVE DB (${dbPath}) under vitest. Unit tests must ` +
        `inject an in-memory db via injectTestDb(new Database(':memory:')).\n` +
        `Offending call site:\n${new Error().stack}`,
    );
  }

  liveDb = openDb(dbPath);
  return liveDb;
}

export function closeDb(): void {
  if (liveDb) {
    liveDb.close();
    liveDb = null;
  }
}

/** Test helper: a fresh in-memory db with the full schema applied. */
export function createTestDb(): Db {
  const db = new Database(':memory:');
  applyConnectionPragmas(db);
  initializeSchema(db);
  return db;
}
