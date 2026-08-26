import { sha256Hex, type Db } from '@skillcheck/core';

// Idempotent harvest persistence. Every discovery is an upsert keyed on UNIQUE(repo, path),
// so a killed harvest re-runs safely. Dedupe keeps the HIGHEST-priority source in `source`
// and unions all sources into sources_json (so the methodology can report source overlap).

export const SOURCE_PRIORITY = [
  'anthropics_skills',
  'official_marketplace',
  'community_registry',
  'code_search',
] as const;
export type SourceKind = (typeof SOURCE_PRIORITY)[number];

function priority(s: string): number {
  const i = SOURCE_PRIORITY.indexOf(s as SourceKind);
  return i < 0 ? 999 : i;
}

export function skillId(repo: string, path: string): string {
  return 'sk_' + sha256Hex(`${repo}\n${path}`).slice(0, 16);
}

export interface SkillRecord {
  repo: string;
  path: string;
  source: SourceKind;
  sourceDetail?: string | null;
  name?: string | null;
  description?: string | null;
  frontmatterValid?: boolean;
  frontmatterJson?: string | null;
  repoStars?: number | null;
  repoPushedAt?: string | null;
  repoArchived?: boolean | null;
  repoFork?: boolean | null;
  repoLicense?: string | null;
  defaultBranch?: string | null;
  headSha?: string | null;
  contentSha256?: string | null;
  dirFileCount?: number | null;
  dirBytes?: number | null;
  mirrorPath?: string | null;
  harvestRunId: string;
}

const b = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);

/** Insert or merge a skill. Returns its stable id. */
export function upsertSkill(db: Db, rec: SkillRecord): string {
  const id = skillId(rec.repo, rec.path);
  const existing = db
    .prepare('SELECT source, sources_json FROM skills WHERE repo=? AND path=?')
    .get(rec.repo, rec.path) as { source: string; sources_json: string | null } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO skills
        (id, repo, path, source, source_detail, sources_json, name, description,
         frontmatter_valid, frontmatter_json, repo_stars, repo_pushed_at, repo_archived,
         repo_fork, repo_license, default_branch, head_sha, content_sha256, dir_file_count,
         dir_bytes, mirror_path, harvest_run_id)
       VALUES
        (@id, @repo, @path, @source, @sourceDetail, @sourcesJson, @name, @description,
         @frontmatterValid, @frontmatterJson, @repoStars, @repoPushedAt, @repoArchived,
         @repoFork, @repoLicense, @defaultBranch, @headSha, @contentSha256, @dirFileCount,
         @dirBytes, @mirrorPath, @harvestRunId)`,
    ).run({
      id,
      repo: rec.repo,
      path: rec.path,
      source: rec.source,
      sourceDetail: rec.sourceDetail ?? null,
      sourcesJson: JSON.stringify([rec.source]),
      name: rec.name ?? null,
      description: rec.description ?? null,
      frontmatterValid: rec.frontmatterValid ? 1 : 0,
      frontmatterJson: rec.frontmatterJson ?? null,
      repoStars: rec.repoStars ?? null,
      repoPushedAt: rec.repoPushedAt ?? null,
      repoArchived: b(rec.repoArchived),
      repoFork: b(rec.repoFork),
      repoLicense: rec.repoLicense ?? null,
      defaultBranch: rec.defaultBranch ?? null,
      headSha: rec.headSha ?? null,
      contentSha256: rec.contentSha256 ?? null,
      dirFileCount: rec.dirFileCount ?? null,
      dirBytes: rec.dirBytes ?? null,
      mirrorPath: rec.mirrorPath ?? null,
      harvestRunId: rec.harvestRunId,
    });
    return id;
  }

  const prevSources: string[] = JSON.parse(existing.sources_json ?? '[]');
  const mergedSources = Array.from(new Set([...prevSources, rec.source])).sort();
  const bestSource = priority(rec.source) < priority(existing.source) ? rec.source : existing.source;

  // COALESCE(new, existing): freshly-provided non-null metadata wins; nulls preserve prior.
  db.prepare(
    `UPDATE skills SET
       source = @bestSource,
       sources_json = @sourcesJson,
       source_detail = COALESCE(@sourceDetail, source_detail),
       name = COALESCE(@name, name),
       description = COALESCE(@description, description),
       frontmatter_valid = COALESCE(@frontmatterValidOrNull, frontmatter_valid),
       frontmatter_json = COALESCE(@frontmatterJson, frontmatter_json),
       repo_stars = COALESCE(@repoStars, repo_stars),
       repo_pushed_at = COALESCE(@repoPushedAt, repo_pushed_at),
       repo_archived = COALESCE(@repoArchived, repo_archived),
       repo_fork = COALESCE(@repoFork, repo_fork),
       repo_license = COALESCE(@repoLicense, repo_license),
       default_branch = COALESCE(@defaultBranch, default_branch),
       head_sha = COALESCE(@headSha, head_sha),
       content_sha256 = COALESCE(@contentSha256, content_sha256),
       dir_file_count = COALESCE(@dirFileCount, dir_file_count),
       dir_bytes = COALESCE(@dirBytes, dir_bytes),
       mirror_path = COALESCE(@mirrorPath, mirror_path),
       harvest_run_id = @harvestRunId
     WHERE id = @id`,
  ).run({
    id,
    bestSource,
    sourcesJson: JSON.stringify(mergedSources),
    sourceDetail: rec.sourceDetail ?? null,
    name: rec.name ?? null,
    description: rec.description ?? null,
    // null when this source did not parse frontmatter → COALESCE preserves prior validity.
    frontmatterValidOrNull: rec.frontmatterValid === undefined ? null : rec.frontmatterValid ? 1 : 0,
    frontmatterJson: rec.frontmatterJson ?? null,
    repoStars: rec.repoStars ?? null,
    repoPushedAt: rec.repoPushedAt ?? null,
    repoArchived: b(rec.repoArchived),
    repoFork: b(rec.repoFork),
    repoLicense: rec.repoLicense ?? null,
    defaultBranch: rec.defaultBranch ?? null,
    headSha: rec.headSha ?? null,
    contentSha256: rec.contentSha256 ?? null,
    dirFileCount: rec.dirFileCount ?? null,
    dirBytes: rec.dirBytes ?? null,
    mirrorPath: rec.mirrorPath ?? null,
    harvestRunId: rec.harvestRunId,
  });
  return id;
}

// --- run + task helpers (resumability) --------------------------------------
export function createHarvestRun(db: Db, snapshotDate: string, params: Record<string, unknown>): string {
  const id = 'run_harvest_' + sha256Hex(snapshotDate + JSON.stringify(params)).slice(0, 16);
  db.prepare(
    `INSERT OR REPLACE INTO runs (id, kind, status, snapshot_date, params_json, node_version)
     VALUES (?, 'harvest', 'running', ?, ?, ?)`,
  ).run(id, snapshotDate, JSON.stringify(params), process.version);
  return id;
}

export function finishRun(db: Db, runId: string, status: 'complete' | 'failed'): void {
  db.prepare("UPDATE runs SET status=?, finished_at=datetime('now') WHERE id=?").run(status, runId);
}

export function taskDone(db: Db, runId: string, taskId: string): boolean {
  const row = db.prepare("SELECT status FROM harvest_tasks WHERE id=? AND run_id=?").get(taskId, runId) as
    | { status: string }
    | undefined;
  return row?.status === 'done';
}

export function recordTask(
  db: Db,
  runId: string,
  taskId: string,
  kind: string,
  status: 'pending' | 'done' | 'failed',
  detail?: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO harvest_tasks (id, run_id, kind, status, detail_json, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail_json=excluded.detail_json, updated_at=datetime('now')`,
  ).run(taskId, runId, kind, status, detail ? JSON.stringify(detail) : null);
}

export interface CohortStats {
  total: number;
  bySource: Record<string, number>;
  multiSource: number;
  forks: number;
  invalidFrontmatter: number;
}

export function cohortStats(db: Db): CohortStats {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM skills').get() as { c: number }).c;
  const bySourceRows = db.prepare('SELECT source, COUNT(*) AS c FROM skills GROUP BY source').all() as {
    source: string;
    c: number;
  }[];
  const bySource: Record<string, number> = {};
  for (const r of bySourceRows) bySource[r.source] = r.c;
  const multiSource = (
    db.prepare("SELECT COUNT(*) AS c FROM skills WHERE sources_json LIKE '%,%'").get() as { c: number }
  ).c;
  const forks = (db.prepare('SELECT COUNT(*) AS c FROM skills WHERE repo_fork=1').get() as { c: number }).c;
  const invalidFrontmatter = (
    db.prepare('SELECT COUNT(*) AS c FROM skills WHERE frontmatter_valid=0').get() as { c: number }
  ).c;
  return { total, bySource, multiSource, forks, invalidFrontmatter };
}
