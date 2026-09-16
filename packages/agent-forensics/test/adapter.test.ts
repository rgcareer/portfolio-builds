import { describe, it, expect } from 'vitest';
import { stableStringify } from '@portfolio-builds/shared';
import { loadProtocol } from '../src/protocol';
import { parseTranscript } from '../src/adapters/claudeCode';

const protocol = loadProtocol();
const SALT = 'test-salt-fixed-0123456789';
const parse = (lines: string[]) => parseTranscript(lines, { salt: SALT, protocol });
const J = (o: unknown) => JSON.stringify(o);

const ts = (s: number) => `2026-09-10T10:00:${String(s).padStart(2, '0')}.000Z`;

function assistant(id: string, blocks: unknown[], extra: Record<string, unknown> = {}, uuid = id): string {
  return J({
    type: 'assistant',
    uuid,
    timestamp: ts(1),
    sessionId: 'ffffffff-9dad-41d1-89b4-00c04fd430c8',
    version: '2.0.14',
    message: { id, role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'tool_use', content: blocks, ...extra },
  });
}
function toolUse(id: string, name: string, input: unknown): unknown {
  return { type: 'tool_use', id, name, input };
}
function toolResult(useId: string, content: string, isError = false): unknown {
  return { type: 'tool_result', tool_use_id: useId, is_error: isError, content };
}
function userResult(uuid: string, blocks: unknown[], toolUseResult?: Record<string, unknown>): string {
  const rec: Record<string, unknown> = { type: 'user', uuid, timestamp: ts(2), message: { role: 'user', content: blocks } };
  if (toolUseResult) rec['toolUseResult'] = toolUseResult;
  return J(rec);
}

describe('claude-code adapter', () => {
  it('groups split assistant records by message.id into one llm turn and counts usage once', () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const rec = parse([
      assistant('m1', [{ type: 'text', text: 'part one ' }], { usage }, 'u-a'),
      assistant('m1', [{ type: 'text', text: 'part two' }, toolUse('t1', 'Read', { file: 'x' })], { usage }, 'u-b'),
    ]);
    const llm = rec.turns.filter((t) => t.kind === 'llm');
    expect(llm).toHaveLength(1);
    expect(llm[0]!.textChars).toBe('part one part two'.length);
    // usage counted once (not doubled) and top-level equals the sum over llm turns
    expect(rec.usage.input).toBe(10);
    expect(rec.usage.output).toBe(5);
    expect(rec.toolCalls).toHaveLength(1);
  });

  it('pairs a tool_result to its tool_use by tool_use_id', () => {
    const rec = parse([
      assistant('m1', [toolUse('t1', 'Bash', { command: 'ls' })]),
      userResult('r1', [toolResult('t1', 'file listing here')]),
    ]);
    const call = rec.toolCalls[0]!;
    expect(call.resultTurn).not.toBeNull();
    expect(call.resultHash).not.toBeNull();
    expect(call.isError).toBe(false);
    expect(call.orphan).toBe(false);
  });

  it('dedupes a re-emitted tool_result by record uuid', () => {
    const rec = parse([
      assistant('m1', [toolUse('t1', 'Bash', { command: 'ls' })]),
      userResult('same-uuid', [toolResult('t1', 'listing')]),
      userResult('same-uuid', [toolResult('t1', 'listing')]),
    ]);
    expect(rec.meta['dedupedResults']).toBe(1);
    expect(rec.toolCalls).toHaveLength(1);
  });

  it('marks a result with no matching call as orphan, and a call with no result as dangling', () => {
    const rec = parse([
      assistant('m1', [toolUse('t1', 'Bash', { command: 'sleep 100' })]), // no result -> dangling
      userResult('r1', [toolResult('t-unknown', 'stray result')]), // no call -> orphan
    ]);
    const dangling = rec.toolCalls.find((c) => c.resultTurn === null && !c.orphan);
    const orphan = rec.toolCalls.find((c) => c.orphan);
    expect(dangling).toBeTruthy();
    expect(orphan).toBeTruthy();
    expect(rec.meta['orphanResults']).toBe(1);
  });

  it('counts unknown record types and malformed lines without throwing', () => {
    const rec = parse([
      '{ this is not json',
      J({ type: 'mystery', uuid: 'x', timestamp: ts(1) }),
      assistant('m1', [{ type: 'text', text: 'ok' }], { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    ]);
    expect(rec.meta['malformedLines']).toBe(1);
    expect(rec.meta['unknownTypes']).toBe(1);
  });

  it('collects every schema version into source.schemaVersions (sorted, unique)', () => {
    const rec = parse([
      J({ type: 'assistant', uuid: 'a', timestamp: ts(1), version: '2.0.14', message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'a' }] } }),
      J({ type: 'assistant', uuid: 'b', timestamp: ts(2), version: '2.0.9', message: { id: 'm2', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'b' }] } }),
      J({ type: 'assistant', uuid: 'c', timestamp: ts(3), version: '2.0.14', message: { id: 'm3', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'c' }] } }),
    ]);
    expect(rec.source.schemaVersions).toEqual(['2.0.14', '2.0.9']);
  });

  it('keeps toolUseResult.durationMs while dropping stdout and command', () => {
    const rec = parse([
      assistant('m1', [toolUse('t1', 'Bash', { command: 'ls' })]),
      userResult('r1', [toolResult('t1', 'ok')], { stdout: 'secret stdout contents', command: 'ls -la', durationMs: 99, interrupted: false }),
    ]);
    expect(rec.toolCalls[0]!.durationMs).toBe(99);
    const s = stableStringify(rec);
    expect(s).not.toContain('secret stdout');
    expect(s).not.toContain('ls -la');
  });

  it('records thinking blocks as counts only, never text', () => {
    const rec = parse([
      assistant('m1', [{ type: 'thinking', thinking: 'private chain of thought here' }, { type: 'text', text: 'answer' }]),
    ]);
    expect(rec.meta['thinkingBlocks']).toBe(1);
    expect(rec.meta['thinkingChars']).toBe('private chain of thought here'.length);
    expect(stableStringify(rec)).not.toContain('private chain');
  });

  it('does not treat a compaction summary as a prompt', () => {
    const rec = parse([
      J({ type: 'summary', summary: 'compacted earlier turns', leafUuid: 'x' }),
      J({ type: 'user', uuid: 'u1', timestamp: ts(1), isCompactSummary: true, message: { role: 'user', content: 'this is a compact summary body' } }),
      assistant('m1', [{ type: 'text', text: 'ok' }]),
    ]);
    expect(rec.turns.filter((t) => t.kind === 'prompt')).toHaveLength(0);
    expect(Number(rec.meta['compactSummaries'])).toBeGreaterThanOrEqual(1);
    expect(stableStringify(rec)).not.toContain('compact summary body');
  });

  it('tolerates sidechain records (counts them, still parses)', () => {
    const rec = parse([
      J({ type: 'assistant', uuid: 'a', timestamp: ts(1), isSidechain: true, message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8', content: [toolUse('t1', 'Task', { prompt: 'sub' })] } }),
      userResult('r1', [toolResult('t1', 'sub done')]),
    ]);
    expect(Number(rec.meta['sidechainRecords'])).toBeGreaterThanOrEqual(1);
    expect(rec.toolCalls).toHaveLength(1);
  });

  it('hashes MCP tool names to other:<hex8>', () => {
    const rec = parse([assistant('m1', [toolUse('t1', 'mcp__server__do_thing', { a: 1 })])]);
    expect(rec.toolCalls[0]!.name).toMatch(/^other:[0-9a-f]{8}$/);
    expect(stableStringify(rec)).not.toContain('mcp__server__do_thing');
  });

  it('buckets an observed banned model and discloses the count without storing the string', () => {
    const rec = parse([
      J({ type: 'assistant', uuid: 'a', timestamp: ts(1), message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] } }),
    ]);
    expect(rec.models).toContain('excluded:banned-model');
    expect(rec.meta['bannedModelObserved']).toBe(1);
    expect(stableStringify(rec)).not.toContain('claude-opus-5');
  });
});
