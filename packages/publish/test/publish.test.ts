import { describe, it, expect } from 'vitest';
import { sha256Hex, createTestDb, type Db } from '@skillcheck/core';
import {
  buildArtifacts,
  ensureDisclosures,
  assertDisclosureCoverage,
  getOrCreateSalt,
  loadPublishData,
  PublishError,
} from '../src/serialize';
import { redact } from '../src/redact';

const EVIL_REPO = 'evil-author/malware-skill';
const EVIL_NAME = 'malware-skill';
const EVIL_MATCH = 'https://evil-collector.ngrok.io/exfil';

function seed(withCritical: boolean): Db {
  const db = createTestDb();
  db.prepare("INSERT INTO runs (id,kind,status,snapshot_date) VALUES ('rh','harvest','complete','2026-08-25')").run();
  db.prepare(
    "INSERT INTO runs (id,kind,status,snapshot_date,cohort_hash,ruleset_hash,finished_at) VALUES ('rs','screen','complete','2026-08-25','COH','RUL','2026-08-25T10:00:00Z')",
  ).run();
  const insSkill = (id: string, repo: string, name: string) =>
    db
      .prepare(
        "INSERT INTO skills (id,repo,path,source,name,frontmatter_valid,repo_stars,harvest_run_id) VALUES (?,?,'SKILL.md','code_search',?,1,10,'rh')",
      )
      .run(id, repo, name);
  insSkill('sk_clean', 'good-author/nice-skill', 'nice-skill');
  insSkill('sk_evil', EVIL_REPO, EVIL_NAME);

  const grade = (skill: string, dim: string, tier: string, inputs?: string) =>
    db
      .prepare('INSERT INTO grades (id,run_id,skill_id,dimension,tier,inputs_json) VALUES (?,?,?,?,?,?)')
      .run(`${skill}_${dim}`, 'rs', skill, dim, tier, inputs ?? null);
  grade('sk_clean', 'safety', 'A');
  grade('sk_clean', 'hygiene', 'A', '{"abandoned":false}');
  grade('sk_evil', 'safety', withCritical ? 'F' : 'A');
  grade('sk_evil', 'hygiene', 'B', '{"abandoned":false}');

  if (withCritical) {
    db.prepare(
      "INSERT INTO findings (id,run_id,skill_id,rule_id,pack,severity,file,line,col,matched_text,context,message) VALUES ('f1','rs','sk_evil','EX-004','data-exfiltration','critical','collect.sh',3,1,?,?,'exfil')",
    ).run(EVIL_MATCH, EVIL_MATCH);
  }
  return db;
}

describe('redaction — structural gating', () => {
  it('emits ZERO identifiers for a gated skill across all artifacts', () => {
    const db = seed(true);
    const a = buildArtifacts(db);
    const blob = a.skillsJson + a.findingsJson + a.runMetaJson;
    for (const secret of [EVIL_REPO, EVIL_NAME, EVIL_MATCH, 'collect.sh', 'malware']) {
      expect(blob.includes(secret), `leaked: ${secret}`).toBe(false);
    }
    // the clean skill is still fully named
    expect(a.skillsJson).toContain('good-author/nice-skill');
    // the gated skill exists as an anonymized stub (anti-subtraction)
    const skills = JSON.parse(a.skillsJson) as { anonymized: boolean; safety: string; verdict: string }[];
    expect(skills).toHaveLength(2);
    const anon = skills.find((s) => s.anonymized)!;
    expect(anon.safety).toBe('under_review');
    expect(anon.verdict).toBe('under_review');
    // its withheld findings appear as pack+severity only
    const findings = JSON.parse(a.findingsJson) as { anonymized: boolean; matched: null; pack: string }[];
    const anonF = findings.find((f) => f.anonymized)!;
    expect(anonF.matched).toBeNull();
    expect(anonF.pack).toBe('data-exfiltration');
    // run-meta counts it without identifying it
    const meta = JSON.parse(a.runMetaJson) as { disclosure: { gatedCount: number }; headline: { critical: { numerator: number } } };
    expect(meta.disclosure.gatedCount).toBe(1);
    expect(meta.headline.critical.numerator).toBe(1);
  });

  it('names the skill and shows evidence once disclosure status is disclosed', () => {
    const db = seed(true);
    const salt = getOrCreateSalt(db);
    ensureDisclosures(db, 'rs', salt);
    db.prepare("UPDATE disclosures SET status='disclosed' WHERE skill_id='sk_evil'").run();
    const a = buildArtifacts(db);
    expect(a.skillsJson).toContain(EVIL_REPO); // now named
    expect(a.findingsJson).toContain(EVIL_MATCH); // evidence now public
  });

  it('withdrawn (false-positive) drops the finding and recomputes safety', () => {
    const db = seed(true);
    const salt = getOrCreateSalt(db);
    ensureDisclosures(db, 'rs', salt);
    db.prepare("UPDATE disclosures SET status='withdrawn' WHERE skill_id='sk_evil'").run();
    const a = buildArtifacts(db);
    const blob = a.skillsJson + a.findingsJson;
    expect(blob.includes(EVIL_MATCH)).toBe(false); // finding gone
    const skills = JSON.parse(a.skillsJson) as { repo: string; safety: string }[];
    const evil = skills.find((s) => s.repo === EVIL_REPO)!;
    expect(evil.safety).toBe('A'); // recomputed from remaining (zero) findings
  });
});

describe('disclosure coverage gate', () => {
  it('assertDisclosureCoverage throws when a qualifying finding lacks a row', () => {
    const db = seed(true);
    expect(() => assertDisclosureCoverage(db, 'rs')).toThrow(PublishError);
  });

  it('passes after ensureDisclosures', () => {
    const db = seed(true);
    ensureDisclosures(db, 'rs', getOrCreateSalt(db));
    expect(() => assertDisclosureCoverage(db, 'rs')).not.toThrow();
  });
});

describe('determinism + checksums', () => {
  it('buildArtifacts is byte-identical across runs and self-checksums', () => {
    const db = seed(true);
    const a = buildArtifacts(db);
    const b = buildArtifacts(db);
    expect(a).toEqual(b);
    const meta = JSON.parse(a.runMetaJson) as { checksums: { skills_json: string; findings_json: string } };
    expect(meta.checksums.skills_json).toBe(sha256Hex(a.skillsJson));
    expect(meta.checksums.findings_json).toBe(sha256Hex(a.findingsJson));
  });

  it('a clean cohort (no critical) publishes all skills named', () => {
    const db = seed(false);
    const a = buildArtifacts(db);
    const skills = JSON.parse(a.skillsJson) as { anonymized: boolean }[];
    expect(skills.every((s) => !s.anonymized)).toBe(true);
    const { skills: raw } = loadPublishData(db, 'rs');
    expect(raw).toHaveLength(2);
  });
});

describe('redact() placeholder stability', () => {
  it('same salt + skill id → same placeholder', () => {
    const r1 = redact(
      [{ id: 'x', repo: 'a/b', path: 'SKILL.md', name: null, source: 'code_search', repoStars: null, safety: 'F', hygiene: 'B', abandoned: false }],
      [{ skillId: 'x', ruleId: 'EX-004', pack: 'data-exfiltration', severity: 'critical', file: 'f', line: 1, col: 1, matched: 'm', context: 'c', message: 'msg' }],
      new Map(),
      'fixed-salt',
    );
    const r2 = redact(
      [{ id: 'x', repo: 'a/b', path: 'SKILL.md', name: null, source: 'code_search', repoStars: null, safety: 'F', hygiene: 'B', abandoned: false }],
      [{ skillId: 'x', ruleId: 'EX-004', pack: 'data-exfiltration', severity: 'critical', file: 'f', line: 1, col: 1, matched: 'm', context: 'c', message: 'msg' }],
      new Map(),
      'fixed-salt',
    );
    expect(r1.skills[0]!.id).toBe(r2.skills[0]!.id);
    expect(r1.skills[0]!.id).toMatch(/^SC-ANON-[0-9a-f]{8}$/);
  });
});
