import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDb,
  runMigrations,
  initializeSchema,
  injectTestDb,
  getDb,
  closeDb,
  type Db,
} from '@skillcheck/core';

const EXPECTED_TABLES = [
  'calls',
  'claims',
  'disclosures',
  'findings',
  'grades',
  'harvest_tasks',
  'meta',
  'runs',
  'schema_version',
  'skills',
];

function tableNames(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

let tmpRoot: string;
const tempDirs: string[] = [];
function freshMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpRoot, 'mig-'));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'skillcheck-db-'));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
afterEach(() => {
  // Reset the live-db singleton state the tripwire test touches.
  injectTestDb(null);
  closeDb();
});

describe('schema', () => {
  it('applies the full baseline schema to a fresh in-memory db', () => {
    const db = createTestDb();
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);
  });

  it('enforces enum CHECK constraints', () => {
    const db = createTestDb();
    expect(() => db.prepare("INSERT INTO runs (id, kind) VALUES ('r1', 'bogus')").run()).toThrow(
      /CHECK constraint failed/,
    );
    // valid kind succeeds
    expect(() => db.prepare("INSERT INTO runs (id, kind) VALUES ('r1', 'harvest')").run()).not.toThrow();
  });

  it('enforces UNIQUE(repo, path) dedupe on skills', () => {
    const db = createTestDb();
    db.prepare("INSERT INTO runs (id, kind) VALUES ('r1', 'harvest')").run();
    const insertSkill = (id: string) =>
      db
        .prepare(
          "INSERT INTO skills (id, repo, path, source, harvest_run_id) VALUES (?, 'a/b', 'SKILL.md', 'code_search', 'r1')",
        )
        .run(id);
    insertSkill('sk_1');
    expect(() => insertSkill('sk_2')).toThrow(/UNIQUE constraint failed/);
  });

  it('enforces foreign keys (skills.harvest_run_id must exist)', () => {
    const db = createTestDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO skills (id, repo, path, source, harvest_run_id) VALUES ('sk_1','a/b','SKILL.md','code_search','ghost')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('migrations', () => {
  it('applies a numbered migration transactionally and records its version', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const dir = freshMigrationsDir({
      '002_add_widget.sql': 'CREATE TABLE widget (x INTEGER);',
    });
    runMigrations(db, dir);
    expect(tableNames(db)).toContain('widget');
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(2);
  });

  it('fails closed with the offending filename in the message', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const dir = freshMigrationsDir({ '003_broken.sql': 'THIS IS NOT SQL;' });
    expect(() => runMigrations(db, dir)).toThrow(/Migration 003_broken\.sql failed/);
  });

  it('rolls back a partially-failing migration atomically (no version row, no partial table)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const dir = freshMigrationsDir({
      '002_atomic.sql': 'CREATE TABLE ok_table (x);\nINSERT INTO missing_table VALUES (1);',
    });
    expect(() => runMigrations(db, dir)).toThrow(/Migration 002_atomic\.sql failed/);
    expect(tableNames(db)).not.toContain('ok_table');
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
    expect(v.v).toBeNull();
  });

  it('is idempotent — re-running applies nothing new', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const dir = freshMigrationsDir({ '002_add_widget.sql': 'CREATE TABLE widget (x INTEGER);' });
    runMigrations(db, dir);
    // second run must not throw "table widget already exists" — version gate skips it
    expect(() => runMigrations(db, dir)).not.toThrow();
  });
});

describe('vitest live-db tripwire', () => {
  it('refuses to open a real on-disk db under vitest without injection', () => {
    injectTestDb(null);
    closeDb();
    expect(() => getDb('/tmp/should-never-open-skillcheck.db')).toThrow(
      /attempted to open the LIVE DB .* under vitest/,
    );
  });

  it('returns the injected handle when one is provided', () => {
    const mem = createTestDb();
    injectTestDb(mem);
    expect(getDb()).toBe(mem);
  });
});
