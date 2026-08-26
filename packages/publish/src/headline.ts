import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Generate the launch sentence from run-meta.json — never hand-typed, so the number
// provably comes from the published data. Usage: tsx headline.ts [path/to/run-meta.json]

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Stat {
  numerator: number;
  denominator: number;
}
interface RunMeta {
  snapshotDate: string | null;
  cohortHash: string | null;
  rulesetHash: string | null;
  cohort: { gradedCount: number; bySource: Record<string, number> };
  headline: { injection: Stat; abandoned: Stat; unicode: Stat; critical: Stat };
}

function pct(s: Stat): string {
  if (s.denominator === 0) return '0';
  return (Math.round((10000 * s.numerator) / s.denominator) / 100).toString();
}

export function headlineSentence(meta: RunMeta): string {
  const sources = Object.keys(meta.cohort.bySource);
  const cohort =
    sources.length === 1 && sources[0] === 'anthropics_skills'
      ? `the ${meta.cohort.gradedCount} official Claude Code skills in anthropics/skills`
      : `${meta.cohort.gradedCount} Claude Code skills`;
  const h = meta.headline;
  return (
    `I scanned ${cohort}: ${pct(h.injection)}% carry prompt-injection patterns, ` +
    `${pct(h.abandoned)}% are abandoned, ${pct(h.unicode)}% contain non-standard Unicode, ` +
    `and ${pct(h.critical)}% have a critical finding.`
  );
}

function main(): void {
  const path = process.argv[2] ?? resolve(REPO_ROOT, 'site', 'src', 'data', 'run-meta.json');
  const meta = JSON.parse(readFileSync(path, 'utf8')) as RunMeta;
  process.stdout.write(headlineSentence(meta) + '\n');
  process.stderr.write(
    `\n  snapshot ${meta.snapshotDate} · cohort ${(meta.cohortHash ?? '').slice(0, 16)}… · ruleset ${(meta.rulesetHash ?? '').slice(0, 16)}…\n` +
      `  Reproduce: npm ci && npm run screen -- --sample 25 --seed 7\n`,
  );
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main();
}
