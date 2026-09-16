import { describe, it, expect } from 'vitest';
import { SemanticCache } from '../src/cache';
import { Store, type Namespace } from '../src/store';
import { FakeEmbedder } from '../src/embedder';
import { loadProtocol } from '../src/protocol';
import { sha256Hex } from '@portfolio-builds/shared';

const rules = loadProtocol().cacheRules;

const ns: Namespace = {
  tenant: 'acme',
  model: 'claude-opus-4-8',
  systemSha256: sha256Hex('You are a helpful assistant.'),
  mock: true,
};

function makeCache(tau = 0.9) {
  const store = new Store();
  const embedder = new FakeEmbedder();
  const cache = new SemanticCache({ store, embedder, rules, tau });
  return { store, embedder, cache };
}

describe('SemanticCache', () => {
  it('serves an exact-tier hit without ever calling the embedder', async () => {
    const { cache, embedder } = makeCache();
    await cache.store(ns, 'exact-key-1', 'Please cancel order #4471.', 'Cancelled.', { input: 10, output: 5 }, undefined, '2026-09-15T00:00:00.000Z');
    embedder.embedCount = 0; // store() itself embeds once; reset to isolate the lookup call

    const result = await cache.lookup(ns, 'exact-key-1', 'Please cancel order #4471.', '2026-09-15T00:00:05.000Z');
    expect(result.decision).toBe('hit');
    expect(result.reason).toBe('exact');
    expect(embedder.embedCount).toBe(0);
  });

  it('serves a semantic-tier hit when cosine similarity is at or above tau and no guard vetoes', async () => {
    const { cache } = makeCache(0.5);
    await cache.store(ns, 'exact-key-2', 'Please cancel order #4471.', 'Cancelled.', null, undefined, '2026-09-15T00:00:00.000Z');

    const result = await cache.lookup(ns, 'a-different-exact-key', 'Can you cancel order #4471 for me?', '2026-09-15T00:00:05.000Z');
    expect(result.decision).toBe('hit');
    expect(result.reason).toBe('semantic');
    expect(result.similarity).not.toBeNull();
    expect(result.similarity!).toBeGreaterThanOrEqual(0.5);
  });

  it('misses when the best candidate is below tau', async () => {
    const { cache } = makeCache(0.999);
    await cache.store(ns, 'exact-key-3', 'Please cancel order #4471.', 'Cancelled.', null, undefined, '2026-09-15T00:00:00.000Z');

    const result = await cache.lookup(ns, 'another-key', 'Please renew the certificate for api.example.internal.', '2026-09-15T00:00:05.000Z');
    expect(result.decision).toBe('miss');
    expect(result.reason).toBe('below-threshold');
  });

  it('misses and logs a guard veto when the best candidate is a near-miss (different order number)', async () => {
    const { cache, store } = makeCache(0.5);
    await cache.store(ns, 'exact-key-4', 'Please cancel order #4471.', 'Cancelled.', null, undefined, '2026-09-15T00:00:00.000Z');

    const result = await cache.lookup(ns, 'yet-another-key', 'Please cancel order #4417.', '2026-09-15T00:00:05.000Z');
    expect(result.decision).toBe('miss');
    expect(result.reason).toMatch(/^guard-veto:/);
    const events = store.countEvents('miss');
    expect(events).toBeGreaterThan(0);
  });
});
