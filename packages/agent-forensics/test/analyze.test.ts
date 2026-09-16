import { describe, it, expect } from 'vitest';
import { protocol, sess } from './helpers';
import { analyzeRecords, headlineFromRunMeta } from '../src/analyze';
import { stableStringify } from '@portfolio-builds/shared';
import type { RunRecord } from '@portfolio-builds/shared';

const loop = (sid: string): RunRecord =>
  sess(sid).prompt('x').toolUse('a', 'Bash', { command: 's' }).result('a', 'same').toolUse('b', 'Bash', { command: 's' }).result('b', 'same').toolUse('c', 'Bash', { command: 's' }).result('c', 'same').build();
const refusal = (sid: string): RunRecord => sess(sid).prompt('x').llm('no', 'refusal').build();
const clean = (sid: string): RunRecord => sess(sid).prompt('x').toolUse('a', 'Read', { file: 'f' }).result('a', 'ok').llm('done').build();

describe('analyze', () => {
  const records = [loop('s1'), loop('s2'), refusal('s3'), clean('s4'), clean('s5')];

  it('counts sessions and headline hits, and emits Wilson percent strings', () => {
    const { runMeta } = analyzeRecords(records, protocol, { generatedAt: 'FIXED' });
    expect(runMeta.sessions).toBe(5);
    expect(runMeta.k).toBe(3); // 2 loop + 1 refusal
    expect(runMeta.pct.p).toBe('60.0');
    expect(runMeta.pct.lo).toMatch(/^\d+\.\d$/);
    expect(runMeta.pct.hi).toMatch(/^\d+\.\d$/);
    expect(runMeta.toolCalls).toBeGreaterThan(0);
  });

  it('picks the most frequent headline class (count desc, name asc)', () => {
    const { runMeta } = analyzeRecords(records, protocol, { generatedAt: 'FIXED' });
    expect(runMeta.topClass).toBe('LOOP');
    expect(runMeta.topK).toBe(2);
  });

  it('breaks a topClass tie by name ascending', () => {
    const { runMeta } = analyzeRecords([loop('a'), refusal('b')], protocol, { generatedAt: 'FIXED' });
    expect(runMeta.topClass).toBe('LOOP'); // LOOP and REFUSAL tie at 1; LOOP sorts first
    expect(runMeta.topK).toBe(1);
  });

  it('is deterministic for the same inputs', () => {
    const a = analyzeRecords(records, protocol, { generatedAt: 'FIXED' });
    const b = analyzeRecords(records, protocol, { generatedAt: 'FIXED' });
    expect(stableStringify(a.runMeta)).toBe(stableStringify(b.runMeta));
    expect(stableStringify(a.findings)).toBe(stableStringify(b.findings));
  });

  it('renders the headline only from run-meta (never hand-typed)', () => {
    const { runMeta } = analyzeRecords(records, protocol, { generatedAt: 'FIXED' });
    const sentence = headlineFromRunMeta(runMeta, protocol);
    expect(sentence).toContain('Across 5 of my own Claude Code sessions');
    expect(sentence).toContain('the most frequent is LOOP (2 sessions)');
    expect(sentence).not.toMatch(/\{[a-z_]+\}/); // no unresolved placeholders
  });

  it('refuses to analyze at n=0', () => {
    expect(() => analyzeRecords([], protocol)).toThrow(/n=0/);
  });
});
