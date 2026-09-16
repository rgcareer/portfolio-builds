import { describe, it, expect } from 'vitest';
import { cachedCallLlm } from '../src/wrapper';
import { SemanticCache } from '../src/cache';
import { Store } from '../src/store';
import { FakeEmbedder } from '../src/embedder';
import { loadProtocol } from '../src/protocol';
import { Ledger, MODELS } from '@portfolio-builds/shared';

const rules = loadProtocol().cacheRules;

function makeCache(tau = 0.9) {
  const store = new Store();
  const embedder = new FakeEmbedder();
  return { store, embedder, cache: new SemanticCache({ store, embedder, rules, tau }) };
}

describe('cachedCallLlm', () => {
  it('on a miss, calls the mocked LLM and stores the result under the exact key', async () => {
    const { cache } = makeCache();
    const ledger = new Ledger();
    let calls = 0;
    const spec = { system: 'sys', user: 'Please cancel order #4471.', model: MODELS.opus };
    const { result, record } = await cachedCallLlm(spec, {
      cache,
      ledger,
      mock: async () => {
        calls++;
        return 'Cancelled.';
      },
    });
    expect(calls).toBe(1);
    expect(result.content).toBe('Cancelled.');
    expect(record.cache!.decision).toBe('miss');
    expect(ledger.count()).toBe(1);

    // Confirm it was actually stored: an identical call should now hit without invoking the mock.
    let secondCalls = 0;
    const { result: second, record: secondRecord } = await cachedCallLlm(spec, {
      cache,
      ledger,
      mock: async () => {
        secondCalls++;
        return 'should not be called';
      },
    });
    expect(secondCalls).toBe(0);
    expect(second.content).toBe('Cancelled.');
    expect(secondRecord.cache!.decision).toBe('hit');
  });

  it('on a repeated identical call, hits the cache, adds no new ledger row, and reports avoidedUsage', async () => {
    const { cache } = makeCache();
    const ledger = new Ledger();
    const spec = { system: 'sys', user: 'Please reset the password for jdoe123.', model: MODELS.opus };
    await cachedCallLlm(spec, { cache, ledger, mock: async () => 'Password reset.' });
    expect(ledger.count()).toBe(1);

    const { result, record } = await cachedCallLlm(spec, {
      cache,
      ledger,
      mock: async () => {
        throw new Error('must not be called on a cache hit');
      },
    });
    expect(result.content).toBe('Password reset.');
    expect(record.cache!.decision).toBe('hit');
    expect(record.cache!.avoidedUsage).not.toBeNull();
    expect(ledger.count()).toBe(1); // unchanged: no LLM call was made
  });

  it('bypasses the cache with a reason for a non-cacheable spec (e.g. tool use)', async () => {
    const { cache } = makeCache();
    const ledger = new Ledger();
    const spec = { system: 'sys', user: 'Please cancel order #4471.', model: MODELS.opus, tools: [{ name: 'lookup' }] };
    let calls = 0;
    const { record } = await cachedCallLlm(spec, {
      cache,
      ledger,
      mock: async () => {
        calls++;
        return 'ok';
      },
    });
    expect(calls).toBe(1);
    expect(record.cache!.decision).toBe('bypass');
    expect(record.cache!.reason).toBe('tools');
    expect(record.cache!.avoidedUsage).toBeNull();
  });

  it('never stores an errored LLM result', async () => {
    const { cache, store } = makeCache();
    const ledger = new Ledger();
    const spec = { system: 'sys', user: 'Please cancel order #4471.', model: MODELS.opus };
    const { result } = await cachedCallLlm(spec, {
      cache,
      ledger,
      mock: async () => {
        throw new Error('boom');
      },
    });
    expect(result.error).not.toBeNull();

    const { record: secondRecord } = await cachedCallLlm(spec, { cache, ledger, mock: async () => 'finally worked' });
    expect(secondRecord.cache!.decision).toBe('miss'); // nothing was stored from the errored call
  });
});
