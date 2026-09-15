import { describe, it, expect } from 'vitest';
import {
  parseRunRecord,
  validateRunRecord,
  RunRecordParseError,
  fromAgentTrace,
  toAgentTrace,
  isTokenShaped,
  type RunRecord,
  type AgentTraceV1,
} from '../src/runrecord';

function hashedRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    recordVersion: '1',
    runId: 's_abcdef012345',
    source: { kind: 'claude-code-transcript', adapter: 'claudeCode@1', schemaVersions: ['2.1.260'] },
    redaction: 'hashed',
    startedAt: '2026-09-15T00:00:00Z',
    endedAt: '2026-09-15T00:05:00Z',
    models: ['claude-opus-4-8'],
    turns: [
      { index: 0, kind: 'prompt', at: '2026-09-15T00:00:00Z', textHash: 'a'.repeat(40), textChars: 12 },
      { index: 1, kind: 'llm', at: '2026-09-15T00:00:05Z', model: 'claude-opus-4-8', stopReason: 'tool_use', usage: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 } },
    ],
    toolCalls: [
      { id: 'c_1', name: 'Bash', callTurn: 1, resultTurn: null, inputHash: 'b'.repeat(40), inputBytes: 30, resultHash: null, resultBytes: null, isError: false, errorClass: null, durationMs: 12, interrupted: false, timedOut: false, denied: false, orphan: true },
    ],
    usage: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
    costUsd: null,
    outcome: { status: 'completed' },
    meta: { version: '2.1.260' },
    ...over,
  };
}

describe('RunRecord validation', () => {
  it('accepts a well-formed hashed record', () => {
    expect(validateRunRecord(hashedRecord())).toEqual([]);
    expect(() => parseRunRecord(hashedRecord())).not.toThrow();
  });

  it('forbids free text on a turn when redaction is hashed', () => {
    const bad = hashedRecord();
    (bad.turns[0] as unknown as Record<string, unknown>)['text'] = 'secret prompt';
    const issues = validateRunRecord(bad);
    expect(issues.some((i) => i.path === 'turns[0].text')).toBe(true);
    expect(() => parseRunRecord(bad)).toThrow(RunRecordParseError);
  });

  it('allows verbatim text only for eval-item / agent-trace-v1 sources', () => {
    const evalRec = hashedRecord({
      source: { kind: 'eval-item', adapter: 'regress@1', schemaVersions: ['eval-1'] },
      redaction: 'verbatim',
      turns: [{ index: 0, kind: 'llm', at: '2026-09-15T00:00:00Z', model: 'claude-sonnet-5', text: 'the answer', usage: { input: 5, output: 3, cacheRead: 0, cacheCreation: 0 } }],
      usage: { input: 5, output: 3, cacheRead: 0, cacheCreation: 0 },
    });
    expect(validateRunRecord(evalRec)).toEqual([]);
    const bad = hashedRecord({ redaction: 'verbatim' }); // claude-code-transcript + verbatim
    expect(validateRunRecord(bad).some((i) => i.path === 'redaction')).toBe(true);
  });

  it('requires top-level usage to equal the sum over llm turns', () => {
    const bad = hashedRecord({ usage: { input: 999, output: 20, cacheRead: 0, cacheCreation: 0 } });
    expect(validateRunRecord(bad).some((i) => i.path === 'usage.input')).toBe(true);
  });

  it('rejects a non-ISO timestamp and a non-hex textHash', () => {
    const bad = hashedRecord();
    (bad.turns[0] as unknown as Record<string, unknown>)['at'] = 'yesterday';
    (bad.turns[0] as unknown as Record<string, unknown>)['textHash'] = 'NOTHEX!!';
    const issues = validateRunRecord(bad);
    expect(issues.some((i) => i.path === 'turns[0].at')).toBe(true);
    expect(issues.some((i) => i.path === 'turns[0].textHash')).toBe(true);
  });

  it('rejects non-scalar meta values', () => {
    const bad = hashedRecord({ meta: { nested: { a: 1 } as unknown as string } });
    expect(validateRunRecord(bad).some((i) => i.path === 'meta.nested')).toBe(true);
  });
});

describe('token shape', () => {
  it('accepts HMAC tokens and hex hashes, rejects raw uuids and prose', () => {
    expect(isTokenShaped('s_ab12cd34ef')).toBe(true);
    expect(isTokenShaped('a'.repeat(40))).toBe(true);
    expect(isTokenShaped('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(isTokenShaped('/Users/x/secret')).toBe(false);
  });
});

describe('Agent Trace v1 interop', () => {
  const trace: AgentTraceV1 = {
    traceId: 'trace-1',
    startedAt: '2026-09-15T00:00:00Z',
    endedAt: '2026-09-15T00:00:03Z',
    steps: [
      { kind: 'llm', at: '2026-09-15T00:00:00Z', model: 'claude-sonnet-5', text: 'thinking', usage: { input: 10, output: 4 } },
      { kind: 'tool_call', at: '2026-09-15T00:00:01Z', name: 'search', input: { q: 'x' } },
      { kind: 'tool_result', at: '2026-09-15T00:00:02Z', output: { hits: 3 }, isError: false },
    ],
  };

  it('converts a trace to a valid verbatim RunRecord and pairs the tool call', () => {
    const rr = fromAgentTrace(trace);
    expect(() => parseRunRecord(rr)).not.toThrow();
    expect(rr.redaction).toBe('verbatim');
    expect(rr.toolCalls[0]!.name).toBe('search');
    expect(rr.toolCalls[0]!.resultTurn).toBe(2);
    expect(rr.toolCalls[0]!.orphan).toBe(false);
    expect(rr.usage).toEqual({ input: 10, output: 4, cacheRead: 0, cacheCreation: 0 });
  });

  it('round-trips back to a trace with the same step kinds', () => {
    const back = toAgentTrace(fromAgentTrace(trace));
    expect(back.traceId).toBe('trace-1');
    expect(back.steps.map((s) => s.kind)).toEqual(['llm', 'tool_call', 'tool_result']);
    expect(back.steps[1]!.name).toBe('search');
  });
});
