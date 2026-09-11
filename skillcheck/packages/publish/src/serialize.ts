import { randomBytes } from 'node:crypto';
import { stableStringify, sha256Hex, type Db } from '@skillcheck/core';
import { SEVERITY_ORDER } from '@skillcheck/screen';
import {
  redact,
  placeholderId,
  DISCLOSURE_SEVERITIES,
  type RawSkill,
  type RawFinding,
  type DisclosureStatus,
} from './redact';

// SQLite → published JSON. Loads the latest completed screen run, ensures a disclosures row
// exists for every qualifying finding, redacts, and emits canonical, checksummed artifacts.
// Wall-clock-free (timestamps come from the stored run), so publish is byte-identical on re-run.

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

export function getOrCreateSalt(db: Db): string {
  const row = db.prepare("SELECT value FROM meta WHERE key='anon_salt'").get() as { value: string } | undefined;
  if (row) return row.value;
  const salt = randomBytes(32).toString('hex');
  db.prepare("INSERT INTO meta (key, value) VALUES ('anon_salt', ?)").run(salt);
  return salt;
}

interface ScreenRunRow {
  id: string;
  snapshot_date: string | null;
  seed: number | null;
  sample_n: number | null;
  cohort_hash: string | null;
  ruleset_hash: string | null;
  code_version: string | null;
  node_version: string | null;
  finished_at: string | null;
}

export function latestScreenRun(db: Db): ScreenRunRow {
  const row = db
    .prepare("SELECT * FROM runs WHERE kind='screen' AND status='complete' ORDER BY finished_at DESC, id DESC LIMIT 1")
    .get() as ScreenRunRow | undefined;
  if (!row) throw new PublishError('No completed screen run found — run `screen` first.');
  return row;
}

interface SkillGradeRow extends RawSkill {
  hygiene_inputs: string | null;
}

export function loadPublishData(db: Db, runId: string): { skills: RawSkill[]; findings: RawFinding[]; disclosure: Map<string, DisclosureStatus> } {
  const rows = db
    .prepare(
      `SELECT sk.id, sk.repo, sk.path, sk.name, sk.source, sk.repo_stars AS repoStars,
              gs.tier AS safety, gh.tier AS hygiene, gh.inputs_json AS hygiene_inputs
       FROM skills sk
       JOIN grades gs ON gs.skill_id = sk.id AND gs.run_id = @run AND gs.dimension = 'safety'
       JOIN grades gh ON gh.skill_id = sk.id AND gh.run_id = @run AND gh.dimension = 'hygiene'
       ORDER BY sk.repo, sk.path`,
    )
    .all({ run: runId }) as SkillGradeRow[];

  const skills: RawSkill[] = rows.map((r) => {
    let abandoned = false;
    try {
      abandoned = Boolean(r.hygiene_inputs ? JSON.parse(r.hygiene_inputs).abandoned : false);
    } catch {
      /* ignore */
    }
    return {
      id: r.id,
      repo: r.repo,
      path: r.path,
      name: r.name,
      source: r.source,
      repoStars: r.repoStars,
      safety: r.safety,
      hygiene: r.hygiene,
      abandoned,
    };
  });

  const findings = db
    .prepare(
      `SELECT skill_id AS skillId, rule_id AS ruleId, pack, severity, file, line, col,
              matched_text AS matched, context, message
       FROM findings WHERE run_id = ?`,
    )
    .all(runId) as RawFinding[];

  const disclosure = new Map<string, DisclosureStatus>();
  for (const d of db.prepare('SELECT skill_id, status FROM disclosures').all() as {
    skill_id: string;
    status: DisclosureStatus;
  }[]) {
    disclosure.set(d.skill_id, d.status);
  }

  return { skills, findings, disclosure };
}

/** Create a disclosures row (pending_notice) for every skill with a qualifying finding. */
export function ensureDisclosures(db: Db, runId: string, salt: string): number {
  const qualifying = db
    .prepare(
      `SELECT DISTINCT skill_id FROM findings
       WHERE run_id = ? AND severity IN (${DISCLOSURE_SEVERITIES.map(() => '?').join(',')})`,
    )
    .all(runId, ...DISCLOSURE_SEVERITIES) as { skill_id: string }[];

  const ins = db.prepare(
    `INSERT OR IGNORE INTO disclosures (skill_id, first_critical_run_id, placeholder_id, status)
     VALUES (?, ?, ?, 'pending_notice')`,
  );
  let created = 0;
  const tx = db.transaction(() => {
    for (const q of qualifying) {
      const info = ins.run(q.skill_id, runId, placeholderId(salt, q.skill_id));
      if (info.changes > 0) created++;
    }
  });
  tx();
  return created;
}

/** Refuse to publish if any qualifying finding lacks a disclosures row (defense in depth). */
export function assertDisclosureCoverage(db: Db, runId: string): void {
  const missing = db
    .prepare(
      `SELECT DISTINCT f.skill_id FROM findings f
       LEFT JOIN disclosures d ON d.skill_id = f.skill_id
       WHERE f.run_id = ? AND f.severity IN (${DISCLOSURE_SEVERITIES.map(() => '?').join(',')})
         AND d.skill_id IS NULL`,
    )
    .all(runId, ...DISCLOSURE_SEVERITIES) as { skill_id: string }[];
  if (missing.length > 0) {
    throw new PublishError(
      `Refusing to publish: ${missing.length} skill(s) with a qualifying finding lack a disclosures row. ` +
        `Run ensureDisclosures first.`,
    );
  }
}

const PI_PACK = 'prompt-injection';
const MEDIUM = SEVERITY_ORDER.medium;

export interface PublishArtifacts {
  skillsJson: string;
  findingsJson: string;
  runMetaJson: string;
}

function headlineCounts(skills: RawSkill[], findings: RawFinding[]) {
  const bySkill = new Map<string, RawFinding[]>();
  for (const f of findings) {
    const a = bySkill.get(f.skillId);
    if (a) a.push(f);
    else bySkill.set(f.skillId, [f]);
  }
  const has = (id: string, pred: (f: RawFinding) => boolean) => (bySkill.get(id) ?? []).some(pred);
  const den = skills.length;
  const injection = skills.filter((s) =>
    has(s.id, (f) => f.pack === PI_PACK && SEVERITY_ORDER[f.severity as keyof typeof SEVERITY_ORDER] >= MEDIUM),
  ).length;
  const abandoned = skills.filter((s) => s.abandoned).length;
  const unicode = skills.filter((s) => has(s.id, (f) => f.pack === 'unicode')).length;
  const critical = skills.filter((s) => has(s.id, (f) => f.severity === 'critical')).length;
  return {
    injection: { numerator: injection, denominator: den, definition: 'skills with >=1 prompt-injection-pack finding at severity >= medium' },
    abandoned: { numerator: abandoned, denominator: den, definition: 'repo archived OR last push more than 365 days before snapshot_date' },
    unicode: { numerator: unicode, denominator: den, definition: 'skills with >=1 unicode-pack finding (zero-width / bidi / tag / invisible)' },
    critical: { numerator: critical, denominator: den, definition: 'skills with >=1 critical-severity finding (disclosure-gated)' },
  };
}

/** Build the three canonical artifacts. Pure given (db state, salt). */
export function buildArtifacts(db: Db): PublishArtifacts {
  const salt = getOrCreateSalt(db);
  const run = latestScreenRun(db);
  ensureDisclosures(db, run.id, salt);
  assertDisclosureCoverage(db, run.id);

  const { skills, findings, disclosure } = loadPublishData(db, run.id);
  const redacted = redact(skills, findings, disclosure, salt);

  const invalidCount = (db.prepare('SELECT COUNT(*) AS c FROM skills WHERE frontmatter_valid=0').get() as { c: number }).c;
  const bySourceRows = db.prepare('SELECT source, COUNT(*) AS c FROM skills GROUP BY source').all() as { source: string; c: number }[];
  const bySource: Record<string, number> = {};
  for (const r of bySourceRows) bySource[r.source] = r.c;

  const skillsJson = stableStringify(redacted.skills);
  const findingsJson = stableStringify(redacted.findings);

  const runMeta = {
    generator: 'skillcheck-publish',
    milestone: 'M1',
    screenRunId: run.id,
    screenFinishedAt: run.finished_at,
    snapshotDate: run.snapshot_date,
    seed: run.seed,
    sampleN: run.sample_n,
    cohortHash: run.cohort_hash,
    rulesetHash: run.ruleset_hash,
    codeVersion: run.code_version,
    nodeVersion: run.node_version,
    cohort: {
      gradedCount: skills.length,
      invalidFrontmatter: invalidCount,
      bySource,
    },
    headline: headlineCounts(skills, findings),
    disclosure: {
      gatedCount: redacted.gatedCount,
      withheldFindingCount: redacted.withheldFindingCount,
    },
    notMeasuredInM1: ['effectiveness', 'honesty'],
    checksums: {
      skills_json: sha256Hex(skillsJson),
      findings_json: sha256Hex(findingsJson),
    },
  };

  return { skillsJson, findingsJson, runMetaJson: stableStringify(runMeta) };
}
