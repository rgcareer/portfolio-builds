import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  byteCompare,
  sha256Hex,
  seededSample,
  parseFrontmatter,
  type Db,
} from '@skillcheck/core';
import { scanFiles, readSkillFiles, type SkillFile, type RawFinding } from './engine';
import { extractClaims, type ClaimToken } from './claims';
import type { LoadedRuleset } from './rulesSchema';
import {
  safetyTier,
  hygieneEval,
  verdictFor,
  SEVERITY_ORDER,
  type Tier,
  type Verdict,
  type SkillMeta,
  type HygieneCheck,
} from './grades';

// The screen pipeline. Grading is pure per-skill (gradeSkill); screenSkills orders the
// cohort, samples deterministically, grades in sorted order, and emits a CANONICAL export
// that excludes all run-scoped fields (run id, timestamps) — that export is the bit-for-bit
// reproducibility surface.

export interface SkillInput {
  id: string;
  repo: string;
  path: string;
  source: string;
  repoStars: number | null;
  frontmatterValid: boolean;
  meta: SkillMeta;
  files: SkillFile[];
}

export interface ExportFinding {
  skillId: string;
  ruleId: string;
  pack: string;
  severity: string;
  file: string;
  line: number;
  col: number;
  matched: string;
  context: string;
  message: string;
}

export interface ExportClaim {
  skillId: string;
  claimType: string;
  token: string;
  file: string;
  line: number;
}

export interface GradedSkill {
  id: string;
  repo: string;
  path: string;
  source: string;
  repoStars: number | null;
  frontmatterValid: boolean;
  safety: Tier;
  hygiene: Tier;
  effectiveness: 'not_yet_benchmarked';
  honesty: 'not_yet_benchmarked';
  verdict: Verdict;
  abandoned: boolean;
  ageDays: number | null;
  hygieneChecks: HygieneCheck[];
  findingCount: number;
  claimCount: number;
  hasCritical: boolean;
}

export interface HeadlineStat {
  numerator: number;
  denominator: number;
  definition: string;
}

export interface ScreenExport {
  meta: {
    seed: number | null;
    sampleN: number | null;
    snapshotDate: string | null;
    cohortHash: string;
    rulesetHash: string;
    cohortSize: number;
    invalidCount: number;
    gradedCount: number;
    headline: {
      injection: HeadlineStat;
      abandoned: HeadlineStat;
      unicode: HeadlineStat;
      critical: HeadlineStat;
    };
  };
  skills: GradedSkill[];
  findings: ExportFinding[];
  claims: ExportClaim[];
}

export interface GradeResult {
  skill: GradedSkill;
  findings: ExportFinding[];
  claims: ExportClaim[];
}

/** Grade one skill. Pure: identical whether the skill is graded alone or in a full cohort. */
export function gradeSkill(input: SkillInput, ruleset: LoadedRuleset): GradeResult {
  const rawFindings: RawFinding[] = input.frontmatterValid ? scanFiles(input.files, ruleset.rules) : [];
  const rawClaims: ClaimToken[] = input.frontmatterValid ? extractClaims(input.files) : [];

  const safety = safetyTier(rawFindings);
  const hyg = hygieneEval(input.meta);
  const verdict = verdictFor(safety, hyg.tier);
  const hasCritical = rawFindings.some((f) => SEVERITY_ORDER[f.severity] === 4);

  const skill: GradedSkill = {
    id: input.id,
    repo: input.repo,
    path: input.path,
    source: input.source,
    repoStars: input.repoStars,
    frontmatterValid: input.frontmatterValid,
    safety,
    hygiene: hyg.tier,
    effectiveness: 'not_yet_benchmarked',
    honesty: 'not_yet_benchmarked',
    verdict,
    abandoned: hyg.abandoned,
    ageDays: hyg.ageDays,
    hygieneChecks: hyg.checks,
    findingCount: rawFindings.length,
    claimCount: rawClaims.length,
    hasCritical,
  };

  const findings: ExportFinding[] = rawFindings.map((f) => ({ skillId: input.id, ...f, matched: f.matched }));
  const claims: ExportClaim[] = rawClaims.map((c) => ({
    skillId: input.id,
    claimType: c.claimType,
    token: c.token,
    file: c.file,
    line: c.line,
  }));

  return { skill, findings, claims };
}

function orderInputs(inputs: SkillInput[]): SkillInput[] {
  return inputs.slice().sort((a, b) => byteCompare(`${a.repo}\n${a.path}`, `${b.repo}\n${b.path}`));
}

const PI_PACK = 'prompt-injection';
const MEDIUM = SEVERITY_ORDER.medium;

/**
 * Screen a cohort of skills into a canonical export. Ordering: sort by (repo, path) →
 * hash the valid cohort → deterministically sample → grade in sorted order. Grades are
 * absolute per-skill, so sample membership (not order) is what a --sample run reproduces.
 */
export function screenSkills(
  inputs: SkillInput[],
  ruleset: LoadedRuleset,
  opts: { seed?: number; sampleN?: number | null } = {},
): ScreenExport {
  const ordered = orderInputs(inputs);
  const valid = ordered.filter((s) => s.frontmatterValid);
  const invalidCount = ordered.length - valid.length;
  const cohortHash = sha256Hex(valid.map((s) => s.id).join('\n'));

  const seed = opts.seed ?? 0;
  const sampleN = opts.sampleN ?? null;
  const selected = sampleN === null ? valid : seededSample(valid, sampleN, seed);
  // Emit in stable order regardless of sample shuffle.
  const graded = selected
    .slice()
    .sort((a, b) => byteCompare(`${a.repo}\n${a.path}`, `${b.repo}\n${b.path}`))
    .map((s) => gradeSkill(s, ruleset));

  const skills = graded.map((g) => g.skill);
  const findings = graded.flatMap((g) => g.findings);
  const claims = graded.flatMap((g) => g.claims);

  const gradedCount = skills.length;
  const injectionN = graded.filter((g) =>
    g.findings.some((f) => f.pack === PI_PACK && SEVERITY_ORDER[f.severity as keyof typeof SEVERITY_ORDER] >= MEDIUM),
  ).length;
  const abandonedN = skills.filter((s) => s.abandoned).length;
  const unicodeN = graded.filter((g) => g.findings.some((f) => f.pack === 'unicode')).length;
  const criticalN = skills.filter((s) => s.hasCritical).length;

  const snapshotDate = (selected[0] ?? valid[0] ?? ordered[0])?.meta.snapshot_date ?? null;

  return {
    meta: {
      seed: sampleN === null ? null : seed,
      sampleN,
      snapshotDate,
      cohortHash,
      rulesetHash: ruleset.rulesetHash,
      cohortSize: valid.length,
      invalidCount,
      gradedCount,
      headline: {
        injection: {
          numerator: injectionN,
          denominator: gradedCount,
          definition: 'skills with >=1 prompt-injection-pack finding at severity >= medium',
        },
        abandoned: {
          numerator: abandonedN,
          denominator: gradedCount,
          definition: 'repo archived OR last push more than 365 days before snapshot_date',
        },
        unicode: {
          numerator: unicodeN,
          denominator: gradedCount,
          definition: 'skills with >=1 unicode-pack finding (zero-width / bidi / tag / invisible)',
        },
        critical: {
          numerator: criticalN,
          denominator: gradedCount,
          definition: 'skills with >=1 critical-severity finding (disclosure-gated)',
        },
      },
    },
    skills,
    findings,
    claims,
  };
}

// --- corpus loader (fixture-style dirs: <case>/skill/ + <case>/meta.json) ---------------
export function loadSkillInputsFromCorpus(corpusDir: string): SkillInput[] {
  const cases = readdirSync(corpusDir)
    .filter((n) => statSync(join(corpusDir, n)).isDirectory())
    .sort(byteCompare);
  const inputs: SkillInput[] = [];
  for (const name of cases) {
    const caseDir = join(corpusDir, name);
    const meta = JSON.parse(readFileSync(join(caseDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    const files = readSkillFiles(join(caseDir, 'skill'));
    const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path));
    const fm = skillMd ? parseFrontmatter(skillMd.content) : null;
    const repo = String(meta['repo'] ?? name);
    const path = String(meta['path'] ?? 'SKILL.md');
    inputs.push({
      id: 'sk_' + sha256Hex(`${repo}\n${path}`).slice(0, 16),
      repo,
      path,
      source: String(meta['source'] ?? 'code_search'),
      repoStars: typeof meta['repo_stars'] === 'number' ? meta['repo_stars'] : null,
      frontmatterValid: Boolean(fm?.valid),
      meta: {
        snapshot_date: String(meta['snapshot_date'] ?? ''),
        repo_pushed_at: (meta['repo_pushed_at'] as string | null) ?? null,
        repo_archived: (meta['repo_archived'] as boolean | null) ?? null,
        repo_license: (meta['repo_license'] as string | null) ?? null,
        name: fm?.frontmatter?.name ?? null,
        description: fm?.frontmatter?.description ?? null,
      },
      files,
    });
  }
  return inputs;
}

// --- DB loader + writer ------------------------------------------------------
interface SkillRow {
  id: string;
  repo: string;
  path: string;
  source: string;
  repo_stars: number | null;
  repo_pushed_at: string | null;
  repo_archived: number | null;
  repo_license: string | null;
  name: string | null;
  description: string | null;
  frontmatter_valid: number;
  mirror_path: string | null;
}

/** Load skill inputs from the DB, reading scannable files from the on-disk mirror. */
export function loadSkillInputsFromDb(db: Db, mirrorRoot: string, snapshotDate: string): SkillInput[] {
  const rows = db
    .prepare('SELECT * FROM skills ORDER BY repo, path')
    .all() as SkillRow[];
  return rows.map((r) => {
    const valid = r.frontmatter_valid === 1;
    const files = valid && r.mirror_path ? readSkillFiles(join(mirrorRoot, r.mirror_path)) : [];
    return {
      id: r.id,
      repo: r.repo,
      path: r.path,
      source: r.source,
      repoStars: r.repo_stars,
      frontmatterValid: valid,
      meta: {
        snapshot_date: snapshotDate,
        repo_pushed_at: r.repo_pushed_at,
        repo_archived: r.repo_archived === null ? null : r.repo_archived === 1,
        repo_license: r.repo_license,
        name: r.name,
        description: r.description,
      },
      files,
    };
  });
}

const DIMENSIONS = ['effectiveness', 'safety', 'honesty', 'hygiene'] as const;

/** Persist a screen export's findings, claims, and grades to the DB under a run id. */
export function writeScreenToDb(db: Db, runId: string, exp: ScreenExport): void {
  const insFinding = db.prepare(
    `INSERT OR IGNORE INTO findings (id, run_id, skill_id, rule_id, pack, severity, file, line, col, matched_text, context, message)
     VALUES (@id, @run_id, @skill_id, @rule_id, @pack, @severity, @file, @line, @col, @matched, @context, @message)`,
  );
  const insClaim = db.prepare(
    `INSERT OR IGNORE INTO claims (id, run_id, skill_id, claim_type, token, file, line)
     VALUES (@id, @run_id, @skill_id, @claim_type, @token, @file, @line)`,
  );
  const insGrade = db.prepare(
    `INSERT OR IGNORE INTO grades (id, run_id, skill_id, dimension, tier, inputs_json)
     VALUES (@id, @run_id, @skill_id, @dimension, @tier, @inputs_json)`,
  );

  const tx = db.transaction(() => {
    for (const f of exp.findings) {
      const id = 'fd_' + sha256Hex([runId, f.skillId, f.ruleId, f.file, f.line, f.col, f.matched].join('|')).slice(0, 24);
      insFinding.run({ id, run_id: runId, skill_id: f.skillId, rule_id: f.ruleId, pack: f.pack, severity: f.severity, file: f.file, line: f.line, col: f.col, matched: f.matched, context: f.context, message: f.message });
    }
    for (const c of exp.claims) {
      const id = 'cl_' + sha256Hex([runId, c.skillId, c.claimType, c.token, c.file, c.line].join('|')).slice(0, 24);
      insClaim.run({ id, run_id: runId, skill_id: c.skillId, claim_type: c.claimType, token: c.token, file: c.file, line: c.line });
    }
    for (const s of exp.skills) {
      const tiers: Record<(typeof DIMENSIONS)[number], Tier> = {
        effectiveness: 'not_yet_benchmarked',
        safety: s.safety,
        honesty: 'not_yet_benchmarked',
        hygiene: s.hygiene,
      };
      const inputs: Record<string, unknown> = {
        safety: { findingCount: s.findingCount, hasCritical: s.hasCritical },
        hygiene: { checks: s.hygieneChecks, abandoned: s.abandoned, ageDays: s.ageDays },
      };
      for (const dim of DIMENSIONS) {
        const id = 'gr_' + sha256Hex([runId, s.id, dim].join('|')).slice(0, 24);
        insGrade.run({ id, run_id: runId, skill_id: s.id, dimension: dim, tier: tiers[dim], inputs_json: dim === 'safety' || dim === 'hygiene' ? JSON.stringify(inputs[dim]) : null });
      }
    }
  });
  tx();
}
