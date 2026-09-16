import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunRecord } from '@portfolio-builds/shared';
import { fromAgentTraceFile, toAgentTraceV1 } from '../src/adapters/agentTrace';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, 'fixtures/agent-trace/sample.json');

describe('agent-trace interop', () => {
  it('converts an agenteval sample into a validated RunRecord', () => {
    const rec = fromAgentTraceFile(SAMPLE);
    expect(validateRunRecord(rec)).toEqual([]);
    expect(rec.source.kind).toBe('agent-trace-v1');
    expect(rec.redaction).toBe('verbatim');
    expect(rec.turns.filter((t) => t.kind === 'llm')).toHaveLength(2);
    expect(rec.usage.input).toBe(250); // 100 + 150 summed over llm turns
  });

  it('round-trips back to Agent Trace v1', () => {
    const rec = fromAgentTraceFile(SAMPLE);
    const trace = toAgentTraceV1(rec);
    expect(trace.traceId).toBe('eval-trace-001');
    expect(trace.steps.map((s) => s.kind)).toEqual(['llm', 'tool_call', 'tool_result', 'llm']);
    expect(trace.steps[1]!.name).toBe('search');
  });
});
