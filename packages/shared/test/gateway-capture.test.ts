import { describe, it, expect } from 'vitest';
import { callLlm } from '../src/gateway';
import { MemoryTrafficSink } from '../src/traffic';

const spec = { system: 'You are a test.', user: 'Say hi.', maxTokens: 100 };

function anthropicOk(text: string, usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 20 }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('gateway traffic capture', () => {
  it('emits one content-free record on a mock call', async () => {
    const capture = new MemoryTrafficSink();
    await callLlm(spec, { env: {}, mock: () => 'hi', capture, purpose: 'p', runId: 'r1' });
    expect(capture.records).toHaveLength(1);
    const rec = capture.records[0]!;
    expect(rec.source).toBe('gateway');
    expect(rec.mock).toBe(true);
    expect(rec.purpose).toBe('p');
    // content-free: no prompt/response text, only hashes + lengths
    expect(rec.systemChars).toBe(spec.system.length);
    expect(rec.userChars).toBe(spec.user.length);
    expect(JSON.stringify(rec)).not.toContain('Say hi');
  });

  it('emits a record with the ephemeral cache split on a real cached call', async () => {
    const capture = new MemoryTrafficSink();
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
    };
    await callLlm(
      { ...spec, model: 'claude-haiku-4-5', cacheSystem: true },
      { env: { ANTHROPIC_API_KEY: 'k', PB_SPEND_CAP_USD: '1' }, fetchImpl: anthropicOk('x', usage), capture },
    );
    expect(capture.records).toHaveLength(1);
    const u = capture.records[0]!.usage!;
    expect(u.cacheRead).toBe(40);
    expect(u.cacheCreation5m).toBe(20);
    expect(u.cacheCreation1h).toBe(10);
  });

  it('emits a record even when the call fails (banned model)', async () => {
    const capture = new MemoryTrafficSink();
    const r = await callLlm({ ...spec, model: 'claude-opus-5' }, { env: {}, capture });
    expect(r.error).toMatch(/banned/);
    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]!.error).toMatch(/banned/);
    expect(capture.records[0]!.usage).toBeNull();
  });

  it('does not send temperature in the request body', async () => {
    let sentBody = '';
    const spy = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await callLlm({ ...spec, model: 'claude-haiku-4-5', maxTokens: 10 }, { env: { ANTHROPIC_API_KEY: 'k', PB_SPEND_CAP_USD: '1' }, fetchImpl: spy });
    expect(sentBody).not.toContain('temperature');
  });
});
