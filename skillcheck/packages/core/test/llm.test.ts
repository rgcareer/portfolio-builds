import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { callLlm, createTestDb, type Db } from '@skillcheck/core';

// Minimal Response-like used to mock fetch without touching the network.
function mockFetch(resp: {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  throws?: string;
}): { impl: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls++;
    if (resp.throws) throw new Error(resp.throws);
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      json: async () => resp.json,
      text: async () => resp.text ?? '',
    };
  }) as unknown as typeof fetch;
  return {
    get impl() {
      return impl;
    },
    get calls() {
      return state.calls;
    },
  };
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv['ANTHROPIC_API_KEY'] = process.env.ANTHROPIC_API_KEY;
  savedEnv['SKILLCHECK_LLM_PROVIDER'] = process.env.SKILLCHECK_LLM_PROVIDER;
  savedEnv['ANTHROPIC_MODEL'] = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.SKILLCHECK_LLM_PROVIDER;
  delete process.env.ANTHROPIC_MODEL;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function callsRows(db: Db) {
  return db.prepare('SELECT * FROM calls').all() as Record<string, unknown>[];
}

describe('callLlm — never throws', () => {
  it('returns content + persists a costed calls row on success', async () => {
    const db = createTestDb();
    const f = mockFetch({
      ok: true,
      json: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hello world' }],
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 200,
          output_tokens: 300,
        },
      },
    });
    const res = await callLlm(
      { system: 's', user: 'u', model: 'claude-haiku-4-5' },
      { db, fetchImpl: f.impl, purpose: 'triage' },
    );
    expect(res.error).toBeNull();
    expect(res.content).toBe('hello world');
    // in=1700 tokens @ $1/Mtok + out=300 @ $5/Mtok = 0.0017 + 0.0015
    expect(res.costUsd).toBeCloseTo(0.0032, 10);

    const rows = callsRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: 'claude-haiku-4-5',
      purpose: 'triage',
      input_tokens: 1000,
      cache_read_tokens: 500,
      cache_creation_tokens: 200,
      output_tokens: 300,
      error: null,
    });
    expect(rows[0]!['cost_usd']).toBeCloseTo(0.0032, 10);
  });

  it('returns an error (never throws) on a non-2xx response and logs it', async () => {
    const db = createTestDb();
    const f = mockFetch({ ok: false, status: 500, text: 'boom' });
    const res = await callLlm({ system: 's', user: 'u', model: 'claude-haiku-4-5' }, { db, fetchImpl: f.impl });
    expect(res.content).toBeNull();
    expect(res.error).toMatch(/Anthropic API error \(500\): boom/);
    const rows = callsRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['error']).toMatch(/500/);
    expect(rows[0]!['cost_usd']).toBe(0);
  });

  it('treats an Anthropic refusal as an error', async () => {
    const f = mockFetch({ ok: true, json: { stop_reason: 'refusal', content: [] } });
    const res = await callLlm({ system: 's', user: 'u' }, { fetchImpl: f.impl });
    expect(res.error).toMatch(/refusal/);
    expect(res.content).toBeNull();
  });

  it('returns an error (never throws) when the network call throws', async () => {
    const f = mockFetch({ ok: true, throws: 'ECONNRESET' });
    const res = await callLlm({ system: 's', user: 'u' }, { fetchImpl: f.impl });
    expect(res.error).toMatch(/LLM request failed: ECONNRESET/);
  });

  it('returns a missing-key error without attempting a network call', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const f = mockFetch({ ok: true, json: {} });
    const res = await callLlm({ system: 's', user: 'u' }, { fetchImpl: f.impl });
    expect(res.error).toBe('Anthropic API key not configured');
    expect(f.calls).toBe(0);
  });

  it('rejects an unsupported provider', async () => {
    const res = await callLlm({ system: 's', user: 'u', provider: 'perplexity' });
    expect(res.error).toBe('Unsupported LLM provider: perplexity');
  });

  it('defaults the Opus tier to claude-opus-4-8 (never opus-5)', async () => {
    const f = mockFetch({ ok: true, json: { content: [{ type: 'text', text: 'x' }], usage: {} } });
    const res = await callLlm({ system: 's', user: 'u' }, { fetchImpl: f.impl });
    expect(res.model).toBe('claude-opus-4-8');
  });
});
