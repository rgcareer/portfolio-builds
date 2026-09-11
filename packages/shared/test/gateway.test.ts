import { describe, it, expect } from 'vitest';
import { Ledger } from '../src/ledger';
import { callLlm, readSpendCap } from '../src/gateway';
import { SIMULATED, capConfidence, simulated } from '../src/simulated';

const spec = { system: 'You are a test.', user: 'Say hi.', maxTokens: 100 };

function anthropicOk(text: string, usage = { input_tokens: 100, output_tokens: 20 }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('spend cap parsing', () => {
  it('defaults to 0 (mock mode) when unset, empty, negative, or non-numeric', () => {
    expect(readSpendCap({})).toBe(0);
    expect(readSpendCap({ PB_SPEND_CAP_USD: '' })).toBe(0);
    expect(readSpendCap({ PB_SPEND_CAP_USD: '-5' })).toBe(0);
    expect(readSpendCap({ PB_SPEND_CAP_USD: 'ten' })).toBe(0);
    expect(readSpendCap({ PB_SPEND_CAP_USD: '12.5' })).toBe(12.5);
  });
});

describe('gateway: mock mode is the default', () => {
  it('refuses a real call when the cap is 0 and no mock responder is given, and never throws', async () => {
    const ledger = new Ledger();
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response('nope');
    }) as unknown as typeof fetch;
    const r = await callLlm(spec, { ledger, env: {}, fetchImpl });
    expect(r.content).toBeNull();
    expect(r.error).toMatch(/mock-mode/);
    expect(fetched).toBe(false);
    expect(ledger.count()).toBe(1);
    expect(ledger.totalCostUsd()).toBe(0);
  });
  it('answers from the mock responder at $0 and ledgers the call as mock', async () => {
    const ledger = new Ledger();
    const r = await callLlm(spec, { ledger, env: {}, mock: () => 'mocked', runId: 'r1', purpose: 'test' });
    expect(r.content).toBe('mocked');
    expect(r.mock).toBe(true);
    expect(r.costUsd).toBe(0);
    expect(ledger.count({ mock: true })).toBe(1);
    expect(ledger.count({ mock: false })).toBe(0);
    expect(ledger.rows('r1')[0]!.purpose).toBe('test');
  });
});

describe('gateway: real calls under a cap', () => {
  const env = { ANTHROPIC_API_KEY: 'test-key', PB_SPEND_CAP_USD: '0.01' };

  it('computes usage-derived cost, persists it, and returns content', async () => {
    const ledger = new Ledger();
    const r = await callLlm({ ...spec, model: 'claude-haiku-4-5' }, { ledger, env, fetchImpl: anthropicOk('hello') });
    expect(r.error).toBeNull();
    expect(r.content).toBe('hello');
    expect(r.mock).toBe(false);
    // 100 in @ $1/M + 20 out @ $5/M
    expect(r.costUsd).toBeCloseTo(0.0001 + 0.0001, 9);
    expect(ledger.totalCostUsd()).toBeCloseTo(0.0002, 9);
  });

  it('refuses before calling when the ceiling would exceed the cap', async () => {
    const ledger = new Ledger();
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response('x');
    }) as unknown as typeof fetch;
    // opus-4-8 with max_tokens 100000 -> ceiling >> $0.01
    const r = await callLlm({ ...spec, maxTokens: 100_000 }, { ledger, env, fetchImpl });
    expect(fetched).toBe(false);
    expect(r.error).toMatch(/spend-cap/);
  });

  it('stops once the ledger total reaches the cap', async () => {
    const ledger = new Ledger();
    const big = anthropicOk('x', { input_tokens: 2000, output_tokens: 200 }); // haiku: $0.002+$0.001 = $0.003
    // Cap equals the first call's actual cost, so the second call must be refused outright.
    const opts = { ledger, env: { ...env, PB_SPEND_CAP_USD: '0.003' }, fetchImpl: big };
    const a = await callLlm({ ...spec, model: 'claude-haiku-4-5', maxTokens: 10 }, opts);
    expect(a.error).toBeNull();
    const b = await callLlm({ ...spec, model: 'claude-haiku-4-5', maxTokens: 10 }, opts);
    expect(b.error).toMatch(/spend-cap/);
    expect(ledger.count({ mock: false, errorsOnly: false })).toBe(2);
    expect(ledger.count({ errorsOnly: true })).toBe(1);
  });

  it('refuses a banned model even under a cap', async () => {
    const r = await callLlm({ ...spec, model: 'claude-opus-5' }, { env, fetchImpl: anthropicOk('x') });
    expect(r.error).toMatch(/banned/);
  });

  it('never throws on API errors, refusals, or network failures', async () => {
    const apiErr = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const refusal = (async () =>
      new Response(JSON.stringify({ stop_reason: 'refusal', content: [], usage: { input_tokens: 5, output_tokens: 0 } }), { status: 200 })) as unknown as typeof fetch;
    const boom = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    const small = { ...spec, model: 'claude-haiku-4-5', maxTokens: 10 };
    expect((await callLlm(small, { env, fetchImpl: apiErr })).error).toMatch(/429/);
    expect((await callLlm(small, { env, fetchImpl: refusal })).error).toMatch(/refusal/);
    expect((await callLlm(small, { env, fetchImpl: boom })).error).toMatch(/ENOTFOUND/);
  });

  it('refuses when the key is missing', async () => {
    const r = await callLlm({ ...spec, model: 'claude-haiku-4-5', maxTokens: 10 }, { env: { PB_SPEND_CAP_USD: '1' }, fetchImpl: anthropicOk('x') });
    expect(r.error).toMatch(/key/);
  });
});

describe('[SIMULATED] convention', () => {
  it('caps simulated confidence at 0.80 and leaves measured confidence alone', () => {
    expect(capConfidence(0.95, SIMULATED)).toBe(0.8);
    expect(capConfidence(0.95, 'measured')).toBe(0.95);
    expect(simulated('x', 1, 'claude-sonnet-5')).toEqual({ value: 'x', independence: '[SIMULATED]', confidence: 0.8, model: 'claude-sonnet-5' });
  });
});
