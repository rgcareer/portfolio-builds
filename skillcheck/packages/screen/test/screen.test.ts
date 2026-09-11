import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { stableStringify, createTestDb } from '@skillcheck/core';
import { loadRuleset } from '../src/rulesSchema';
import { screenSkills, gradeSkill, loadSkillInputsFromCorpus, writeScreenToDb, type SkillInput } from '../src/screen';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREEN_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(SCREEN_DIR, '..', '..');
const RULES = resolve(SCREEN_DIR, 'rules');
const CORPUS = resolve(SCREEN_DIR, 'fixtures', 'corpus');
const ruleset = loadRuleset(RULES);

function synthInputs(n: number): SkillInput[] {
  return Array.from({ length: n }, (_, i) => {
    const id = String(i).padStart(3, '0');
    return {
      id: 'sk_' + id,
      repo: 'org/s' + id,
      path: 'SKILL.md',
      source: 'code_search',
      repoStars: i,
      frontmatterValid: true,
      meta: {
        snapshot_date: '2026-08-25',
        repo_pushed_at: '2026-08-10T00:00:00Z',
        repo_archived: false,
        repo_license: 'MIT',
        name: 's' + id,
        description: 'a synthetic skill used for determinism testing',
      },
      files: [{ path: 'SKILL.md', content: `---\nname: s${id}\ndescription: synthetic\n---\nclean body` }],
    };
  });
}

describe('screenSkills determinism', () => {
  it('is bit-for-bit reproducible for a fixed seed + sample', () => {
    const inputs = synthInputs(100);
    const a = screenSkills(inputs, ruleset, { sampleN: 25, seed: 7 });
    const b = screenSkills(inputs, ruleset, { sampleN: 25, seed: 7 });
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('reproduces the pinned sample-25 seed-7 selection', () => {
    const exp = screenSkills(synthInputs(100), ruleset, { sampleN: 25, seed: 7 });
    expect(exp.skills.map((s) => s.id)).toEqual([
      'sk_001', 'sk_007', 'sk_008', 'sk_024', 'sk_029', 'sk_030', 'sk_033', 'sk_034', 'sk_035',
      'sk_036', 'sk_039', 'sk_040', 'sk_042', 'sk_043', 'sk_046', 'sk_049', 'sk_054', 'sk_058',
      'sk_061', 'sk_070', 'sk_075', 'sk_079', 'sk_090', 'sk_097', 'sk_098',
    ]);
  });

  it('a different seed selects a different sample', () => {
    const a = screenSkills(synthInputs(100), ruleset, { sampleN: 25, seed: 7 });
    const b = screenSkills(synthInputs(100), ruleset, { sampleN: 25, seed: 8 });
    expect(a.skills.map((s) => s.id)).not.toEqual(b.skills.map((s) => s.id));
  });
});

describe('grades are absolute (graded alone == graded in cohort)', () => {
  it('a skill gets identical grades whether screened alone or with 99 others', () => {
    const inputs = loadSkillInputsFromCorpus(CORPUS);
    const target = inputs.find((i) => i.repo === 'acme/installer')!; // dangerous-rmrf
    const full = screenSkills(inputs, ruleset, {});
    const alone = screenSkills([target], ruleset, {});
    const inFull = full.skills.find((s) => s.id === target.id)!;
    const solo = alone.skills[0]!;
    expect({ safety: solo.safety, hygiene: solo.hygiene, verdict: solo.verdict }).toEqual({
      safety: inFull.safety,
      hygiene: inFull.hygiene,
      verdict: inFull.verdict,
    });
    // and gradeSkill directly agrees
    expect(gradeSkill(target, ruleset).skill.safety).toBe(inFull.safety);
  });
});

describe('corpus headline numbers', () => {
  const exp = screenSkills(loadSkillInputsFromCorpus(CORPUS), ruleset, {});
  it('excludes the invalid-frontmatter skill from the graded cohort', () => {
    expect(exp.meta.invalidCount).toBe(1);
    expect(exp.meta.cohortSize).toBe(10);
    expect(exp.meta.gradedCount).toBe(10);
  });
  it('counts the headline dimensions correctly', () => {
    expect(exp.meta.headline.injection.numerator).toBe(2); // injection-basic, combined-nasty (NOT injection-docs)
    expect(exp.meta.headline.abandoned.numerator).toBe(1); // abandoned
    expect(exp.meta.headline.unicode.numerator).toBe(2); // unicode-hidden, combined-nasty
    // critical = dangerous-rmrf (DC-002), exfil-secret (EX-004), unicode-hidden (UNI-002/003 bidi+tag), combined-nasty (EX-004/UNI-002)
    expect(exp.meta.headline.critical.numerator).toBe(4);
  });
  it('the dangerous skill floors to Avoid', () => {
    const danger = exp.skills.find((s) => s.repo === 'acme/installer')!;
    expect(danger.safety).toBe('F');
    expect(danger.verdict).toBe('Avoid');
  });
});

describe('writeScreenToDb', () => {
  it('persists findings, claims, and 4 grade rows per skill; idempotent', () => {
    const db = createTestDb();
    db.prepare("INSERT INTO runs (id, kind, snapshot_date) VALUES ('r_h','harvest','2026-08-25')").run();
    db.prepare("INSERT INTO runs (id, kind) VALUES ('r_s','screen')").run();
    for (const id of ['sk1', 'sk2']) {
      db.prepare(
        "INSERT INTO skills (id, repo, path, source, frontmatter_valid, harvest_run_id) VALUES (?, ?, 'SKILL.md', 'code_search', 1, 'r_h')",
      ).run(id, 'acme/' + id);
    }
    const exp: any = {
      meta: {},
      skills: [
        { id: 'sk1', safety: 'F', hygiene: 'B', hasCritical: true, findingCount: 1, claimCount: 1, hygieneChecks: [], abandoned: false, ageDays: 10 },
        { id: 'sk2', safety: 'A', hygiene: 'A', hasCritical: false, findingCount: 0, claimCount: 0, hygieneChecks: [], abandoned: false, ageDays: 5 },
      ],
      findings: [
        { skillId: 'sk1', ruleId: 'DC-002', pack: 'dangerous-command', severity: 'critical', file: 'x.sh', line: 1, col: 1, matched: 'rm -rf /', context: 'rm -rf /', message: 'crit' },
      ],
      claims: [{ skillId: 'sk1', claimType: 'metric', token: '99%', file: 'SKILL.md', line: 3 }],
    };
    writeScreenToDb(db, 'r_s', exp);
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    expect(count('findings')).toBe(1);
    expect(count('claims')).toBe(1);
    expect(count('grades')).toBe(8); // 2 skills × 4 dimensions
    const safety = db.prepare("SELECT tier FROM grades WHERE skill_id='sk1' AND dimension='safety'").get() as { tier: string };
    expect(safety.tier).toBe('F');
    // idempotent re-write
    writeScreenToDb(db, 'r_s', exp);
    expect(count('grades')).toBe(8);
  });
});

describe('CLI end-to-end determinism (screen --sample --seed)', () => {
  it('produces byte-identical --out across two runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skillcheck-cli-'));
    const cli = join(SCREEN_DIR, 'src', 'cli.ts');
    const out1 = join(dir, 'a.json');
    const out2 = join(dir, 'b.json');
    const argsFor = (out: string) => ['tsx', cli, '--corpus', CORPUS, '--sample', '5', '--seed', '7', '--out', out];
    execFileSync('npx', argsFor(out1), { cwd: REPO_ROOT, stdio: 'ignore' });
    execFileSync('npx', argsFor(out2), { cwd: REPO_ROOT, stdio: 'ignore' });
    expect(readFileSync(out1, 'utf8')).toBe(readFileSync(out2, 'utf8'));
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
