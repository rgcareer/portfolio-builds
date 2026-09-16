import { describe, it, expect } from 'vitest';
import { protocol, sess } from './helpers';
import { runDetectors, detectorSet } from '../src/detectors';
import type { RunRecord } from '@portfolio-builds/shared';

const fires = (rec: RunRecord, name: string) => detectorSet(runDetectors(rec, protocol)).includes(name as never);

describe('detectors: one positive + one near-miss negative each', () => {
  it('LOOP: >=3 identical calls in a window fire; 2 do not', () => {
    const pos = sess().prompt('x').toolUse('a', 'Bash', { command: 's' }).result('a', 'same').toolUse('b', 'Bash', { command: 's' }).result('b', 'same').toolUse('c', 'Bash', { command: 's' }).result('c', 'same').build();
    const neg = sess().prompt('x').toolUse('a', 'Bash', { command: 's' }).result('a', 'same').toolUse('b', 'Bash', { command: 's' }).result('b', 'same').build();
    expect(fires(pos, 'LOOP')).toBe(true);
    expect(fires(neg, 'LOOP')).toBe(false);
  });

  it('RETRY: 3 consecutive error results fire; 2 do not', () => {
    const pos = sess().prompt('x').toolUse('a', 'Bash', { command: 'a' }).result('a', 'a exit code 1', { isError: true }).toolUse('b', 'Bash', { command: 'b' }).result('b', 'b exit code 1', { isError: true }).toolUse('c', 'Bash', { command: 'c' }).result('c', 'c exit code 1', { isError: true }).build();
    const neg = sess().prompt('x').toolUse('a', 'Bash', { command: 'a' }).result('a', 'a exit code 1', { isError: true }).toolUse('b', 'Bash', { command: 'b' }).result('b', 'b exit code 1', { isError: true }).toolUse('c', 'Bash', { command: 'c' }).result('c', 'ok').build();
    expect(fires(pos, 'RETRY')).toBe(true);
    expect(fires(neg, 'RETRY')).toBe(false);
  });

  it('APIERR: a system api_error fires; a clean session does not', () => {
    const pos = sess().prompt('x').llm('working', 'tool_use').system('api_error', { status: 529 }).build();
    const neg = sess().prompt('x').llm('done').build();
    expect(fires(pos, 'APIERR')).toBe(true);
    expect(fires(neg, 'APIERR')).toBe(false);
  });

  it('REFUSAL: a refusal stop reason fires; end_turn does not', () => {
    const pos = sess().prompt('x').llm('no', 'refusal').build();
    const neg = sess().prompt('x').llm('sure', 'end_turn').build();
    expect(fires(pos, 'REFUSAL')).toBe(true);
    expect(fires(neg, 'REFUSAL')).toBe(false);
  });

  it('DANGLE: a call with no result fires; a paired call does not', () => {
    const pos = sess().prompt('x').toolUse('a', 'Bash', { command: 'sleep' }).llm('waiting', 'tool_use').build();
    const neg = sess().prompt('x').toolUse('a', 'Bash', { command: 'ls' }).result('a', 'ok').llm('done').build();
    expect(fires(pos, 'DANGLE')).toBe(true);
    expect(fires(neg, 'DANGLE')).toBe(false);
  });

  it('HOOKERR: a non-empty hookErrors fires; an empty one does not', () => {
    const pos = sess().prompt('x').llm('edit', 'tool_use').raw({ type: 'system', uuid: 'h', subtype: 'hook', hookErrors: ['blocked'] }).build();
    const neg = sess().prompt('x').llm('edit').raw({ type: 'system', uuid: 'h', subtype: 'hook', hookErrors: [] }).build();
    expect(fires(pos, 'HOOKERR')).toBe(true);
    expect(fires(neg, 'HOOKERR')).toBe(false);
  });

  it('TIMEOUT: a timed-out call fires; a fast call does not', () => {
    const pos = sess().prompt('x').toolUse('a', 'Bash', { command: 'sleep' }).result('a', 'Command timed out', { isError: true, toolUseResult: { timedOutAfterMs: 120000 } }).build();
    const neg = sess().prompt('x').toolUse('a', 'Bash', { command: 'echo' }).result('a', 'ok', { toolUseResult: { durationMs: 4 } }).build();
    expect(fires(pos, 'TIMEOUT')).toBe(true);
    expect(fires(neg, 'TIMEOUT')).toBe(false);
  });

  it('TOOLERR: >=5 calls with >=2 errors fire; fewer errors do not', () => {
    const build = (errAt: number[]) => {
      const s = sess().prompt('x');
      for (let i = 0; i < 6; i++) {
        const isError = errAt.includes(i);
        s.toolUse(`c${i}`, 'Bash', { command: `cmd${i}` }).result(`c${i}`, isError ? `cmd${i} exit code 1` : 'ok', { isError });
      }
      return s.build();
    };
    expect(fires(build([1, 4]), 'TOOLERR')).toBe(true);
    expect(fires(build([2]), 'TOOLERR')).toBe(false);
  });

  it('DENIAL: a denied call fires; a normal call does not', () => {
    const pos = sess().prompt('x').toolUse('a', 'Bash', { command: 'rm -rf /' }).result('a', 'denied', { toolUseResult: { toolDenialKind: 'permission' } }).build();
    const neg = sess().prompt('x').toolUse('a', 'Bash', { command: 'ls' }).result('a', 'ok').build();
    expect(fires(pos, 'DENIAL')).toBe(true);
    expect(fires(neg, 'DENIAL')).toBe(false);
  });

  it('INTERRUPT: an interrupted call fires; a normal call does not', () => {
    const pos = sess().prompt('x').toolUse('a', 'Bash', { command: 'long' }).result('a', 'partial', { toolUseResult: { interrupted: true } }).build();
    const neg = sess().prompt('x').toolUse('a', 'Bash', { command: 'quick' }).result('a', 'done', { toolUseResult: { interrupted: false } }).build();
    expect(fires(pos, 'INTERRUPT')).toBe(true);
    expect(fires(neg, 'INTERRUPT')).toBe(false);
  });

  it('COMPACT: a compaction summary fires; a short session does not', () => {
    const pos = sess().raw({ type: 'summary', summary: 'compacted', leafUuid: 'x' }).prompt('after').llm('resumed').build();
    const neg = sess().prompt('short').llm('done').build();
    expect(fires(pos, 'COMPACT')).toBe(true);
    expect(fires(neg, 'COMPACT')).toBe(false);
  });

  it('headline-set detectors are exactly the seven pre-registered ones', () => {
    expect([...protocol.headlineSet].sort()).toEqual(['APIERR', 'DANGLE', 'HOOKERR', 'LOOP', 'REFUSAL', 'RETRY', 'TIMEOUT']);
  });
});
