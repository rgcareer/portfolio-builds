import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger, stableStringifyLine, type TrafficRecord } from '@portfolio-builds/shared';
import { readTraffic, importLedger, filterWindow } from '../src/traffic';

function rec(overrides: Partial<TrafficRecord> = {}): TrafficRecord {
  return {
    v: 1,
    id: 'abc123',
    ts: '2026-08-20T10:00:00.000Z',
    source: 'claude-code',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    purpose: null,
    runId: null,
    tenant: null,
    tags: {},
    latencyTolerant: false,
    session: 's_1',
    sidechain: false,
    systemSha256: null,
    systemChars: null,
    userSha256: null,
    userChars: null,
    usage: { input: 100, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 50 },
    mock: false,
    error: null,
    cache: null,
    ...overrides,
  };
}

describe('traffic: JSONL round-trip', () => {
  it('readTraffic reads every *.jsonl file in a directory back into records', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'lca-traffic-'));
    try {
      const a = rec({ id: 'a' });
      const b = rec({ id: 'b' });
      writeFileSync(resolve(dir, 'one.jsonl'), stableStringifyLine(a));
      writeFileSync(resolve(dir, 'two.jsonl'), stableStringifyLine(b));
      const out = readTraffic(dir);
      expect(out.map((r) => r.id).sort()).toEqual(['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the directory does not exist', () => {
    expect(readTraffic(resolve(tmpdir(), 'lca-traffic-does-not-exist'))).toEqual([]);
  });

  it('ignores non-jsonl files in the directory', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'lca-traffic-'));
    try {
      writeFileSync(resolve(dir, 'readme.txt'), 'not jsonl');
      writeFileSync(resolve(dir, 'a.jsonl'), stableStringifyLine(rec({ id: 'only' })));
      const out = readTraffic(dir);
      expect(out.length).toBe(1);
      expect(out[0]!.id).toBe('only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('traffic: importLedger', () => {
  it('skips mock rows and error rows, and tallies them', () => {
    const dbPath = resolve(mkdtempSync(resolve(tmpdir(), 'lca-ledger-')), 'ledger.db');
    const ledger = new Ledger(dbPath);
    ledger.insert({ provider: 'anthropic', model: 'claude-opus-4-8', usage: { input: 10, output: 5 }, costUsd: 0.001, mock: true });
    ledger.insert({ provider: 'anthropic', model: 'claude-opus-4-8', usage: { input: 10, output: 5 }, costUsd: 0, error: 'boom' });
    ledger.insert({ provider: 'anthropic', model: 'claude-opus-4-8', usage: { input: 111, cacheRead: 22, cacheCreation: 33, output: 44 }, costUsd: 0.002 });
    ledger.close();

    const { records, tallies } = importLedger(dbPath);
    expect(tallies.skippedMock).toBe(1);
    expect(tallies.skippedError).toBe(1);
    expect(records.length).toBe(1);
  });

  it('maps cache_creation_tokens to cacheCreation5m and tags ttlAssumed 5m', () => {
    const dbPath = resolve(mkdtempSync(resolve(tmpdir(), 'lca-ledger-')), 'ledger.db');
    const ledger = new Ledger(dbPath);
    ledger.insert({ provider: 'anthropic', model: 'claude-sonnet-5', usage: { input: 1, cacheRead: 2, cacheCreation: 3, output: 4 }, costUsd: 0.0001 });
    ledger.close();

    const { records } = importLedger(dbPath);
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.usage).toEqual({ input: 1, cacheRead: 2, cacheCreation5m: 3, cacheCreation1h: 0, output: 4 });
    expect(r.tags.ttlAssumed).toBe('5m');
    expect(r.source).toBe('ledger');
    expect(r.mock).toBe(false);
    expect(r.error).toBeNull();
  });
});

describe('traffic: filterWindow', () => {
  it('is inclusive of both boundary dates', () => {
    const recs = [rec({ id: 'lo', ts: '2026-08-16T00:00:00.000Z' }), rec({ id: 'hi', ts: '2026-09-15T23:59:59.000Z' }), rec({ id: 'before', ts: '2026-08-15T23:59:59.000Z' }), rec({ id: 'after', ts: '2026-09-16T00:00:00.000Z' })];
    const out = filterWindow(recs, '2026-08-16', '2026-09-15');
    expect(out.map((r) => r.id).sort()).toEqual(['hi', 'lo']);
  });
});
