// L0 — measured, $0. Does the page state its own first-success milestone, and a
// time-to-first-success claim? Patterns come from the frozen protocol; nothing here is
// tunable after seed time.

import type { Checks } from './protocol';
import { fencedBlocks, lines } from './markdown';

export interface MilestoneHit {
  /** 1-based line in the scoped text */
  line: number;
  /** the whole line, verbatim */
  text: string;
  /** which frozen pattern matched (its index in checks.l0.milestone.patterns) */
  patternIndex: number;
  /** the first fenced block starting within 3 lines after the hit, if any */
  expectedOutput: string | null;
}

export interface TimeClaimHit {
  line: number;
  text: string;
  value: string;
  unit: string;
  where: 'title' | 'h1' | 'lead';
}

export function compileMilestonePatterns(checks: Checks): RegExp[] {
  const flags = checks.l0.milestone.flags.includes('m') ? checks.l0.milestone.flags : checks.l0.milestone.flags + 'm';
  return checks.l0.milestone.patterns.map((p) => new RegExp(p, flags.replace(/g/g, '')));
}

/**
 * First line (document order) that any milestone pattern matches. Ties within a line go to
 * the lowest pattern index. Returns null when no line matches.
 */
export function findMilestone(text: string, checks: Checks): MilestoneHit | null {
  const res = compileMilestonePatterns(checks);
  const ls = lines(text);
  const blocks = fencedBlocks(text);
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    for (let p = 0; p < res.length; p++) {
      if (res[p]!.test(l)) {
        const after = blocks.find((b) => b.startLine > i + 1 && b.startLine <= i + 1 + 3);
        return { line: i + 1, text: l, patternIndex: p, expectedOutput: after ? after.code : null };
      }
    }
  }
  return null;
}

export function findTimeClaim(text: string, title: string | null, checks: Checks): TimeClaimHit | null {
  const re = new RegExp(checks.l0.time_claim.pattern, checks.l0.time_claim.flags.replace(/g/g, ''));
  if (title) {
    const m = re.exec(title);
    if (m) return { line: 0, text: title, value: m[1]!, unit: m[2]!, where: 'title' };
  }
  const ls = lines(text);
  const h1 = ls.findIndex((l) => /^#\s+/.test(l));
  if (h1 >= 0) {
    const m = re.exec(ls[h1]!);
    if (m) return { line: h1 + 1, text: ls[h1]!, value: m[1]!, unit: m[2]!, where: 'h1' };
  }
  let consumed = 0;
  for (let i = 0; i < ls.length && consumed < 1500; i++) {
    const l = ls[i]!;
    const m = re.exec(l.slice(0, Math.max(0, 1500 - consumed)));
    if (m) return { line: i + 1, text: l, value: m[1]!, unit: m[2]!, where: 'lead' };
    consumed += l.length + 1;
  }
  return null;
}
