import { describe, it, expect } from 'vitest';
import { protocol, sess } from './helpers';
import { buildTimeline, blameSpan, minimalRepro } from '../src/timeline';
import { runDetectors } from '../src/detectors';

describe('timeline: blame span and minimal repro', () => {
  it('blame span is the earliest highest-severity signature', () => {
    // COMPACT (info, early) then REFUSAL (high, later): blame must be the high-severity one.
    const rec = sess().raw({ type: 'summary', summary: 'compacted', leafUuid: 'x' }).prompt('after').llm('no', 'refusal').build();
    const sigs = runDetectors(rec, protocol);
    const blame = blameSpan(sigs, protocol);
    expect(blame?.detector).toBe('REFUSAL');
  });

  it('among equal severities, blame is the earliest by turnStart', () => {
    // Two DANGLE calls (both medium). The earliest one wins.
    const rec = sess().prompt('x').toolUse('a', 'Bash', { command: 'one' }).toolUse('b', 'Read', { file: 'y' }).llm('hang', 'tool_use').build();
    const sigs = runDetectors(rec, protocol).filter((s) => s.detector === 'DANGLE');
    expect(sigs.length).toBeGreaterThanOrEqual(2);
    const blame = blameSpan(sigs, protocol)!;
    expect(blame.turnStart).toBe(Math.min(...sigs.map((s) => s.turnStart)));
  });

  it('minimal repro is the shortest suffix that still reproduces the signature', () => {
    const rec = sess()
      .prompt('preamble one')
      .llm('thinking')
      .prompt('preamble two')
      .toolUse('a', 'Bash', { command: 's' })
      .result('a', 'same')
      .toolUse('b', 'Bash', { command: 's' })
      .result('b', 'same')
      .toolUse('c', 'Bash', { command: 's' })
      .result('c', 'same')
      .build();
    const tl = buildTimeline(rec, protocol);
    expect(tl.blame?.detector).toBe('LOOP');
    const repro = tl.repro!;
    expect(repro.detector).toBe('LOOP');
    // The suffix starts at the first looped call (dropping the preamble) and still fires.
    expect(repro.startTurn).toBe(rec.toolCalls[0]!.callTurn);
    expect(repro.startTurn).toBeGreaterThan(0);
    expect(repro.turns).toBeLessThan(rec.turns.length);
  });

  it('buildTimeline attaches tool calls to their call turn in order', () => {
    const rec = sess().prompt('x').toolUse('a', 'Bash', { command: 'ls' }).result('a', 'ok').build();
    const tl = buildTimeline(rec, protocol);
    const withCalls = tl.entries.filter((e) => e.calls.length > 0);
    expect(withCalls).toHaveLength(1);
    expect(withCalls[0]!.calls[0]!.name).toBe('Bash');
    expect(tl.entries.map((e) => e.index)).toEqual([...tl.entries].map((e) => e.index).sort((a, b) => a - b));
  });

  it('minimalRepro of a turn-based signature returns that turn', () => {
    const rec = sess().prompt('x').llm('working', 'tool_use').system('api_error', { status: 500 }).build();
    const sigs = runDetectors(rec, protocol).filter((s) => s.detector === 'APIERR');
    const repro = minimalRepro(rec, sigs[0]!, protocol);
    expect(repro.detector).toBe('APIERR');
    expect(repro.startTurn).toBe(sigs[0]!.turnStart);
  });
});
