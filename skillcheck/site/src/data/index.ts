// Typed wrapper over the published JSON (written by `npm run publish`). Types are defined
// locally so the Astro build stays decoupled from the TS packages (no better-sqlite3 in the
// build graph). A build-time shape assert fails the build loudly if the data drifts.
import skillsRaw from './skills.json';
import findingsRaw from './findings.json';
import runMetaRaw from './run-meta.json';

export type Tier = 'A' | 'B' | 'C' | 'D' | 'F' | 'not_yet_benchmarked' | 'under_review';

export interface PublicSkill {
  id: string;
  anonymized: boolean;
  repo: string | null;
  path: string | null;
  name: string | null;
  source: string;
  stars: number | null;
  safety: Tier;
  hygiene: Tier;
  effectiveness: 'not_yet_benchmarked';
  honesty: 'not_yet_benchmarked';
  verdict: string;
  abandoned: boolean;
  findingCount: number;
  withheldFindingCount: number;
}

export interface PublicFinding {
  skillId: string;
  anonymized: boolean;
  ruleId: string;
  pack: string;
  severity: string;
  file: string | null;
  line: number | null;
  col: number | null;
  matched: string | null;
  context: string | null;
  message: string | null;
}

export interface HeadlineStat {
  numerator: number;
  denominator: number;
  definition: string;
}

export interface RunMeta {
  generator: string;
  milestone: string;
  screenRunId: string;
  screenFinishedAt: string | null;
  snapshotDate: string | null;
  seed: number | null;
  sampleN: number | null;
  cohortHash: string | null;
  rulesetHash: string | null;
  codeVersion: string | null;
  nodeVersion: string | null;
  cohort: { gradedCount: number; invalidFrontmatter: number; bySource: Record<string, number> };
  headline: { injection: HeadlineStat; abandoned: HeadlineStat; unicode: HeadlineStat; critical: HeadlineStat };
  disclosure: { gatedCount: number; withheldFindingCount: number };
  notMeasuredInM1: string[];
  checksums: { skills_json: string; findings_json: string };
}

export const skills = skillsRaw as PublicSkill[];
export const findings = findingsRaw as PublicFinding[];
export const runMeta = runMetaRaw as RunMeta;

if (!Array.isArray(skills) || !Array.isArray(findings) || typeof runMeta !== 'object') {
  throw new Error('site/src/data: published JSON is malformed — re-run `npm run publish`.');
}
