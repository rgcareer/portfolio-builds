import { describe, it, expect } from 'vitest';
import { Store, type Namespace } from '../src/store';
import { sha256Hex } from '@portfolio-builds/shared';

const ns = (over: Partial<Namespace> = {}): Namespace => ({
  tenant: 'acme',
  model: 'claude-opus-4-8',
  systemSha256: sha256Hex('You are a helpful assistant.'),
  mock: true,
  ...over,
});

function makeEntry(store: Store, n: Namespace, text: string, exactKey: string, now: string, expiresAt: string | null = null) {
  const vec = new Float32Array([1, 0, 0]);
  return store.insertEntry({
    tenant: n.tenant,
    model: n.model,
    systemSha256: n.systemSha256,
    mock: n.mock,
    exactKey,
    text,
    textSha256: sha256Hex(text),
    textChars: text.length,
    embedding: vec,
    response: `response for ${text}`,
    usage: { input: 10, output: 5 },
    createdAt: now,
    expiresAt,
  });
}

describe('Store', () => {
  it('isolates namespaces across different tenants', () => {
    const store = new Store();
    const now = '2026-09-15T00:00:00.000Z';
    makeEntry(store, ns({ tenant: 'acme' }), 'hello', 'k1', now);
    expect(store.getByExactKey(ns({ tenant: 'acme' }), 'k1')).not.toBeNull();
    expect(store.getByExactKey(ns({ tenant: 'globex' }), 'k1')).toBeNull();
  });

  it('isolates namespaces across different system prompts (same tenant/model)', () => {
    const store = new Store();
    const now = '2026-09-15T00:00:00.000Z';
    const nsA = ns({ systemSha256: sha256Hex('system A') });
    const nsB = ns({ systemSha256: sha256Hex('system B') });
    makeEntry(store, nsA, 'hello', 'k1', now);
    expect(store.getByExactKey(nsA, 'k1')).not.toBeNull();
    expect(store.getByExactKey(nsB, 'k1')).toBeNull();
  });

  it('never serves a mock-namespace entry to a real (non-mock) lookup', () => {
    const store = new Store();
    const now = '2026-09-15T00:00:00.000Z';
    makeEntry(store, ns({ mock: true }), 'hello', 'k1', now);
    expect(store.getByExactKey(ns({ mock: true }), 'k1')).not.toBeNull();
    expect(store.getByExactKey(ns({ mock: false }), 'k1')).toBeNull();
  });

  it('excludes expired entries from namespace listings (TTL expiry) and purges them', () => {
    const store = new Store();
    const n = ns();
    const now = '2026-09-15T00:00:00.000Z';
    const later = '2026-09-16T00:00:00.000Z';
    makeEntry(store, n, 'expired', 'k-expired', now, '2026-09-15T12:00:00.000Z');
    makeEntry(store, n, 'fresh', 'k-fresh', now, '2026-09-20T00:00:00.000Z');

    const live = store.listNamespace(n, later);
    expect(live.map((e) => e.exactKey)).toEqual(['k-fresh']);

    const purged = store.purgeExpired(later);
    expect(purged).toBe(1);
    expect(store.getByExactKey(n, 'k-expired')).toBeNull();
    expect(store.getByExactKey(n, 'k-fresh')).not.toBeNull();
  });

  it('evicts the least-recently-used entries once a namespace exceeds max_entries (LRU)', () => {
    const store = new Store();
    const n = ns();
    const now = '2026-09-15T00:00:00.000Z';
    makeEntry(store, n, 'a', 'k-a', '2026-09-15T00:00:00.000Z');
    makeEntry(store, n, 'b', 'k-b', '2026-09-15T00:00:01.000Z');
    makeEntry(store, n, 'c', 'k-c', '2026-09-15T00:00:02.000Z');
    // touch "a" so it is no longer the least-recently-used despite being oldest by creation.
    const aEntry = store.getByExactKey(n, 'k-a')!;
    store.touchHit(aEntry.id, '2026-09-15T00:00:03.000Z');

    const evicted = store.enforceLru(n, 2);
    expect(evicted).toBe(1);
    const remaining = store.listNamespace(n, now).map((e) => e.exactKey).sort();
    expect(remaining).toEqual(['k-a', 'k-c']);
  });

  it('records one events row per recordEvent call, queryable by decision', () => {
    const store = new Store();
    const n = ns();
    store.recordEvent({ ts: '2026-09-15T00:00:00.000Z', tenant: n.tenant, model: n.model, decision: 'hit', reason: 'exact', similarity: null, matchedId: 'e1', exactKey: 'k1' });
    store.recordEvent({ ts: '2026-09-15T00:00:01.000Z', tenant: n.tenant, model: n.model, decision: 'miss', reason: 'below-threshold', similarity: 0.5, matchedId: null, exactKey: 'k2' });
    expect(store.countEvents()).toBe(2);
    expect(store.countEvents('hit')).toBe(1);
    expect(store.countEvents('miss')).toBe(1);
  });
});
