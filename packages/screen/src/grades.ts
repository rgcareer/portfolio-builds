import type { Severity } from './rulesSchema';

// Deterministic grading. Every grade is an ABSOLUTE per-skill function of that skill's own
// findings + metadata — never cohort-relative — so a sampled run reproduces a full run's
// grades exactly (plan decision #4 / hole H1). No wall clock: hygiene ages are computed
// from snapshot_date (set by harvest, inherited by screen) minus repo_pushed_at.
//
// Effectiveness and Honesty are 'not_yet_benchmarked' in M1 (honest labeling is structural).

export type Tier = 'A' | 'B' | 'C' | 'D' | 'F' | 'not_yet_benchmarked';
export type Dimension = 'effectiveness' | 'safety' | 'honesty' | 'hygiene';
export type Verdict = 'Recommended' | 'Use with care' | 'Avoid' | 'Not yet benchmarked' | 'under_review';

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const ABANDONED_DAYS = 365;
export const FRESH_DAYS = 180;

/**
 * Safety tier from a skill's findings. A = none, B = worst is low/info, C = medium,
 * D = high, F = any critical. A critical finding floors the verdict to Avoid.
 */
export function safetyTier(findings: { severity: Severity }[]): Tier {
  let worst = -1;
  for (const f of findings) worst = Math.max(worst, SEVERITY_ORDER[f.severity]);
  if (worst < 0) return 'A';
  if (worst <= 1) return 'B';
  if (worst === 2) return 'C';
  if (worst === 3) return 'D';
  return 'F';
}

export interface SkillMeta {
  snapshot_date: string;
  repo_pushed_at?: string | null;
  repo_archived?: boolean | null;
  repo_license?: string | null;
  name?: string | null;
  description?: string | null;
}

/** Whole days between two dates (snapshot − pushed). Deterministic: no wall clock. */
export function daysBetween(snapshotDate: string, pushedAt: string): number {
  const s = Date.parse(snapshotDate);
  const p = Date.parse(pushedAt);
  if (Number.isNaN(s) || Number.isNaN(p)) return Number.POSITIVE_INFINITY;
  return Math.floor((s - p) / 86_400_000);
}

export interface HygieneCheck {
  id: string;
  passed: boolean;
}
export interface HygieneResult {
  tier: Tier;
  checks: HygieneCheck[];
  passed: number;
  total: number;
  abandoned: boolean;
  ageDays: number | null;
}

/** Deterministic hygiene checklist evaluated against snapshot_date. */
export function hygieneEval(meta: SkillMeta): HygieneResult {
  const archived = meta.repo_archived === true;
  const pushed = meta.repo_pushed_at ?? null;
  const ageDays = pushed ? daysBetween(meta.snapshot_date, pushed) : null;
  const age = ageDays ?? Number.POSITIVE_INFINITY;
  const abandoned = archived || age > ABANDONED_DAYS;

  const checks: HygieneCheck[] = [
    { id: 'not_archived', passed: !archived },
    { id: 'pushed_within_180d', passed: age <= FRESH_DAYS },
    { id: 'pushed_within_365d', passed: age <= ABANDONED_DAYS },
    { id: 'has_license', passed: Boolean(meta.repo_license && meta.repo_license.trim() !== '') },
    {
      id: 'has_name_and_description',
      passed: Boolean(meta.name && meta.description && meta.description.trim().length >= 20),
    },
  ];
  const passed = checks.filter((c) => c.passed).length;

  let tier: Tier;
  if (abandoned) tier = 'F';
  else if (passed >= 5) tier = 'A';
  else if (passed === 4) tier = 'B';
  else if (passed === 3) tier = 'C';
  else if (passed === 2) tier = 'D';
  else tier = 'F';

  return { tier, checks, passed, total: checks.length, abandoned, ageDays };
}

/**
 * Overall M1 verdict from Safety + Hygiene. Deliberately never "Recommended" — that
 * requires the Effectiveness benchmark (M2). The honest bands in M1 are: Avoid (a critical
 * safety finding), Use with care (any medium/high finding or poor hygiene), and otherwise
 * Not yet benchmarked (clean enough statically, but effectiveness is unmeasured).
 */
export function verdictFor(safety: Tier, hygiene: Tier): Verdict {
  if (safety === 'F') return 'Avoid';
  if (safety === 'C' || safety === 'D') return 'Use with care';
  if (hygiene === 'D' || hygiene === 'F') return 'Use with care';
  return 'Not yet benchmarked';
}
