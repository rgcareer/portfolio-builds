import { describe, it, expect } from 'vitest';
import { createTestDb, type Db } from '@skillcheck/core';
import { upsertSkill, skillId, cohortStats } from '../src/store';

function withRun(): Db {
  const db = createTestDb();
  db.prepare("INSERT INTO runs (id, kind, snapshot_date) VALUES ('r1','harvest','2026-08-25')").run();
  return db;
}

describe('upsertSkill dedupe', () => {
  it('keeps the highest-priority source and unions sources_json', () => {
    const db = withRun();
    // discovered first by code_search (low priority), with partial metadata
    upsertSkill(db, { repo: 'o/r', path: 'SKILL.md', source: 'code_search', harvestRunId: 'r1' });
    // then by anthropics_skills (highest priority), with richer metadata
    const id = upsertSkill(db, {
      repo: 'o/r',
      path: 'SKILL.md',
      source: 'anthropics_skills',
      name: 'my-skill',
      repoStars: 42,
      frontmatterValid: true,
      harvestRunId: 'r1',
    });
    expect(id).toBe(skillId('o/r', 'SKILL.md'));
    const row = db.prepare('SELECT * FROM skills WHERE id=?').get(id) as any;
    expect(row.source).toBe('anthropics_skills'); // priority winner
    expect(JSON.parse(row.sources_json).sort()).toEqual(['anthropics_skills', 'code_search']);
    expect(row.name).toBe('my-skill');
    expect(row.repo_stars).toBe(42);
    expect(row.frontmatter_valid).toBe(1);
  });

  it('does not downgrade source when a lower-priority source re-adds', () => {
    const db = withRun();
    upsertSkill(db, { repo: 'o/r', path: 'SKILL.md', source: 'anthropics_skills', name: 'keep', harvestRunId: 'r1' });
    upsertSkill(db, { repo: 'o/r', path: 'SKILL.md', source: 'code_search', harvestRunId: 'r1' });
    const row = db.prepare('SELECT * FROM skills WHERE repo=? AND path=?').get('o/r', 'SKILL.md') as any;
    expect(row.source).toBe('anthropics_skills'); // not downgraded
    expect(row.name).toBe('keep'); // COALESCE preserves prior non-null on null re-add
    expect(JSON.parse(row.sources_json).sort()).toEqual(['anthropics_skills', 'code_search']);
  });

  it('is idempotent — re-adding the same source keeps one row', () => {
    const db = withRun();
    upsertSkill(db, { repo: 'o/r', path: 'SKILL.md', source: 'code_search', harvestRunId: 'r1' });
    upsertSkill(db, { repo: 'o/r', path: 'SKILL.md', source: 'code_search', harvestRunId: 'r1' });
    expect((db.prepare('SELECT COUNT(*) AS c FROM skills').get() as { c: number }).c).toBe(1);
  });

  it('cohortStats aggregates sources, forks, invalid frontmatter', () => {
    const db = withRun();
    upsertSkill(db, { repo: 'o/a', path: 'SKILL.md', source: 'anthropics_skills', frontmatterValid: true, harvestRunId: 'r1' });
    upsertSkill(db, { repo: 'o/b', path: 'SKILL.md', source: 'code_search', frontmatterValid: false, repoFork: true, harvestRunId: 'r1' });
    upsertSkill(db, { repo: 'o/a', path: 'SKILL.md', source: 'code_search', harvestRunId: 'r1' }); // multi-source
    const s = cohortStats(db);
    expect(s.total).toBe(2);
    expect(s.bySource['anthropics_skills']).toBe(1);
    expect(s.multiSource).toBe(1);
    expect(s.forks).toBe(1);
    expect(s.invalidFrontmatter).toBe(1);
  });
});
