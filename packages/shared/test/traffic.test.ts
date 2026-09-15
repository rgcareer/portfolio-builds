import { describe, it, expect } from 'vitest';
import {
  MemoryTrafficSink,
  validateTrafficRecord,
  readTrafficJsonl,
  emptyUsage,
  type TrafficRecord,
} from '../src/traffic';
import { stableStringifyLine } from '../src/stableJson';
import { assertNoPii } from '../src/pii';

function rec(over: Partial<TrafficRecord> = {}): TrafficRecord {
  return {
    v: 1,
    id: 'abcdef0123456789',
    ts: '2026-09-15T00:00:00Z',
    source: 'gateway',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    purpose: 'test',
    runId: 'r1',
    tenant: null,
    tags: {},
    latencyTolerant: false,
    session: null,
    sidechain: false,
    systemSha256: 'a'.repeat(64),
    systemChars: 10,
    userSha256: 'b'.repeat(64),
    userChars: 5,
    usage: { input: 100, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 20 },
    mock: false,
    error: null,
    cache: null,
    ...over,
  };
}

describe('traffic record validation', () => {
  it('accepts a well-formed record', () => {
    expect(validateTrafficRecord(rec())).toEqual([]);
  });
  it('rejects wrong version, bad source, non-numeric usage', () => {
    expect(validateTrafficRecord(rec({ v: 2 as unknown as 1 }))).toContain('v: must be 1');
    expect(validateTrafficRecord(rec({ source: 'nope' as unknown as 'gateway' }))).toContain('source: invalid');
    const bad = rec();
    (bad.usage as unknown as Record<string, unknown>)['input'] = 'x';
    expect(validateTrafficRecord(bad).some((m) => m.includes('usage.input'))).toBe(true);
  });
  it('allows null usage (a failed or mock call)', () => {
    expect(validateTrafficRecord(rec({ usage: null, mock: true }))).toEqual([]);
  });
});

describe('traffic JSONL round-trip', () => {
  it('writes canonical single-line JSON and reads it back', () => {
    const a = rec({ id: '1111111111111111' });
    const b = rec({ id: '2222222222222222', usage: null });
    const blob = stableStringifyLine(a) + stableStringifyLine(b);
    const back = readTrafficJsonl(blob);
    expect(back).toHaveLength(2);
    expect(back[0]!.id).toBe('1111111111111111');
    expect(back[1]!.usage).toBeNull();
  });
  it('skips blank lines and throws on a malformed line', () => {
    expect(readTrafficJsonl('\n\n')).toEqual([]);
    expect(() => readTrafficJsonl('{not json}\n')).toThrow(/malformed JSON on line 1/);
  });
  it('throws on a structurally invalid record', () => {
    expect(() => readTrafficJsonl(JSON.stringify({ v: 9 }) + '\n')).toThrow(/invalid record on line 1/);
  });
});

describe('memory sink and pii', () => {
  it('collects appended records', () => {
    const sink = new MemoryTrafficSink();
    sink.append(rec());
    sink.append(rec({ id: 'ffffffffffffffff' }));
    expect(sink.records.map((r) => r.id)).toEqual(['abcdef0123456789', 'ffffffffffffffff']);
  });
  it('a serialized record carries no PII (only hashes, counts, enums)', () => {
    expect(() => assertNoPii(stableStringifyLine(rec()), 'traffic-record')).not.toThrow();
  });
  it('emptyUsage is all zeros', () => {
    expect(emptyUsage()).toEqual({ input: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 0 });
  });
});
