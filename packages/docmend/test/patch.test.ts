import { describe, it, expect } from 'vitest';
import { mulberry32 } from '@portfolio-builds/shared';
import { makeUnifiedDiff, makeInsertionDiff, applyUnifiedDiff } from '../src/patch';

describe('makeUnifiedDiff / applyUnifiedDiff round trip (seeded property test)', () => {
  const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

  function buildDoc(rng: () => number, lineCount: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      const wordCount = 1 + Math.floor(rng() * 4);
      const words: string[] = [];
      for (let w = 0; w < wordCount; w++) words.push(WORDS[Math.floor(rng() * WORDS.length)]!);
      out.push(`line-${i}: ${words.join(' ')}`);
    }
    return out;
  }

  it('apply(diff(raw, old, new)) reconstructs the expected text, across 20 seeded cases', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = mulberry32(seed * 7919);
      const lineCount = 5 + Math.floor(rng() * 20);
      const docLines = buildDoc(rng, lineCount);
      const raw = docLines.join('\n') + '\n';

      // Pick a target line and make its whole content the "unique substring" (each line is
      // already unique because of its "line-N:" prefix).
      const targetIdx = Math.floor(rng() * lineCount);
      const oldLine = docLines[targetIdx]!;
      const newLine = `${oldLine} CHANGED-${seed}`;

      const result = makeUnifiedDiff(raw, oldLine, newLine);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const expected = docLines.map((l, i) => (i === targetIdx ? newLine : l)).join('\n') + '\n';
      const applied = applyUnifiedDiff(raw, result.diff);
      expect(applied).toBe(expected);
    }
  });

  it('produces a single hunk with exactly 3 lines of context on each side (interior line)', () => {
    const docLines = Array.from({ length: 11 }, (_, i) => `L${i}`);
    const raw = docLines.join('\n') + '\n';
    const result = makeUnifiedDiff(raw, 'L5', 'L5-CHANGED');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff.match(/^@@/gm)).toHaveLength(1); // single hunk
    expect(result.diff).toContain('@@ -3,7 +3,7 @@');
    expect(result.diff).toContain(' L2\n');
    expect(result.diff).toContain(' L8\n');
    expect(result.diff).toContain('-L5\n');
    expect(result.diff).toContain('+L5-CHANGED\n');
  });
});

describe('ambiguity refusal', () => {
  it('refuses (no diff) when the target substring occurs more than once', () => {
    const raw = 'npm install foo\nsome other line\nnpm install foo\n';
    const result = makeUnifiedDiff(raw, 'npm install foo', 'npm install foo@2.0.0');
    expect(result).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses (no diff) when the target substring is not found at all', () => {
    const raw = 'nothing to see here\n';
    const result = makeUnifiedDiff(raw, 'npm install foo', 'npm install foo@2.0.0');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('accepts when the target line itself is unique even though a similar-but-different line exists', () => {
    const raw = 'npm install foo@1.0.0\nnpm install foobar@1.0.0\n';
    const result = makeUnifiedDiff(raw, 'npm install foo@1.0.0', 'npm install foo@2.0.0');
    expect(result.ok).toBe(true);
  });
});

describe('makeInsertionDiff', () => {
  it('inserts a new line right after the unique anchor line, applied cleanly', () => {
    const raw = 'intro\necho $API_TOKEN\noutro\n';
    const result = makeInsertionDiff(raw, 'echo $API_TOKEN', 'Set the API_TOKEN environment variable first.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyUnifiedDiff(raw, result.diff);
    expect(applied).toBe('intro\necho $API_TOKEN\nSet the API_TOKEN environment variable first.\noutro\n');
  });

  it('refuses when the anchor is not unique', () => {
    const raw = 'echo $X\necho $X\n';
    const result = makeInsertionDiff(raw, 'echo $X', 'note');
    expect(result).toEqual({ ok: false, reason: 'ambiguous' });
  });
});
