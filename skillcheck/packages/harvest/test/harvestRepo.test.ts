import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@skillcheck/core';
import { GitHubClient } from '../src/githubClient';
import { harvestRepo } from '../src/harvestRepo';
import { tarFile, gzTar, makeResponse } from './helpers';

// Route a mock fetch by URL to simulate the GitHub endpoints harvestRepo touches.
function mockGitHub(tarball: Buffer): GitHubClient {
  const tree = {
    sha: 'sha123',
    truncated: false,
    tree: [
      { path: 'skills/good/SKILL.md', type: 'blob' },
      { path: 'skills/good/helper.js', type: 'blob' },
      { path: 'skills/bad/SKILL.md', type: 'blob' },
    ],
  };
  const repo = {
    full_name: 'o/r',
    stargazers_count: 12,
    pushed_at: '2026-08-01T00:00:00Z',
    archived: false,
    fork: false,
    license: { spdx_id: 'MIT' },
    default_branch: 'main',
  };
  return new GitHubClient({
    fetchImpl: (async (url: string) => {
      const u = String(url);
      if (u.includes('/git/trees/')) return makeResponse({ status: 200, body: JSON.stringify(tree) });
      if (u.includes('/tarball/')) return makeResponse({ status: 200, buffer: tarball });
      if (/\/repos\/o\/r$/.test(u)) return makeResponse({ status: 200, body: JSON.stringify(repo) });
      return makeResponse({ status: 404, body: '{}' });
    }) as unknown as typeof fetch,
  });
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('harvestRepo integration', () => {
  it('scans, mirrors, parses frontmatter, and upserts skills', async () => {
    const tarball = gzTar([
      tarFile('o-r-sha/skills/good/SKILL.md', '---\nname: good-skill\ndescription: A valid documented skill.\n---\n# Good\n'),
      tarFile('o-r-sha/skills/good/helper.js', 'console.log(1)'),
      tarFile('o-r-sha/skills/bad/SKILL.md', '---\nname: bad-skill\n---\n# Missing description\n'),
    ]);
    const mirrorRoot = mkdtempSync(join(tmpdir(), 'skillcheck-hr-'));
    tmpDirs.push(mirrorRoot);
    const db = createTestDb();
    db.prepare("INSERT INTO runs (id, kind, snapshot_date) VALUES ('r1','harvest','2026-08-25')").run();
    const client = mockGitHub(tarball);

    const result = await harvestRepo(db, client, 'o/r', 'code_search', null, 'r1', mirrorRoot);
    expect(result.skillCount).toBe(2);
    expect(result.mirrored).toBe(true);

    const rows = db.prepare('SELECT * FROM skills ORDER BY path').all() as any[];
    expect(rows.map((r) => r.path)).toEqual(['skills/bad/SKILL.md', 'skills/good/SKILL.md']);

    const good = rows.find((r) => r.path === 'skills/good/SKILL.md')!;
    expect(good.frontmatter_valid).toBe(1);
    expect(good.name).toBe('good-skill');
    expect(good.repo_stars).toBe(12);
    expect(good.repo_license).toBe('MIT');
    expect(good.mirror_path).toBe('o__r/skills/good');
    expect(good.content_sha256).toMatch(/^[0-9a-f]{64}$/);

    const bad = rows.find((r) => r.path === 'skills/bad/SKILL.md')!;
    expect(bad.frontmatter_valid).toBe(0); // missing description

    // mirror files actually on disk under the guarded destination
    expect(existsSync(join(mirrorRoot, 'o__r', 'skills', 'good', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(mirrorRoot, 'o__r', 'skills', 'good', 'helper.js'))).toBe(true);
  });
});

// Route a mock fetch for a big monorepo whose SKILL.md files live under several
// plugin dirs (the marketplace-repo shape). Used to prove pathPrefixes filtering.
function mockMonorepo(tarball: Buffer): GitHubClient {
  const tree = {
    sha: 'monosha',
    truncated: false,
    tree: [
      { path: 'plugins/p1/skills/a/SKILL.md', type: 'blob' },
      { path: 'plugins/p2/skills/b/SKILL.md', type: 'blob' },
      { path: 'plugins/p3/README.md', type: 'blob' }, // no SKILL.md → 0, recorded
      { path: 'other/skills/c/SKILL.md', type: 'blob' }, // outside the prefixes → excluded
    ],
  };
  const repo = {
    full_name: 'anthropics/claude-code',
    stargazers_count: 1000,
    pushed_at: '2026-09-01T00:00:00Z',
    archived: false,
    fork: false,
    license: { spdx_id: 'MIT' },
    default_branch: 'main',
  };
  return new GitHubClient({
    fetchImpl: (async (url: string) => {
      const u = String(url);
      if (u.includes('/git/trees/')) return makeResponse({ status: 200, body: JSON.stringify(tree) });
      if (u.includes('/tarball/')) return makeResponse({ status: 200, buffer: tarball });
      if (/\/repos\/anthropics\/claude-code$/.test(u)) return makeResponse({ status: 200, body: JSON.stringify(repo) });
      return makeResponse({ status: 404, body: '{}' });
    }) as unknown as typeof fetch,
  });
}

describe('harvestRepo pathPrefixes (local plugin dirs in the marketplace repo)', () => {
  it('filters skills to the prefixes, attributes source_detail per prefix, counts per prefix', async () => {
    const tarball = gzTar([
      tarFile('acc-sha/plugins/p1/skills/a/SKILL.md', '---\nname: a\ndescription: Skill A does a thing.\n---\n'),
      tarFile('acc-sha/plugins/p2/skills/b/SKILL.md', '---\nname: b\ndescription: Skill B does a thing.\n---\n'),
      tarFile('acc-sha/plugins/p3/README.md', 'no skill'),
      tarFile('acc-sha/other/skills/c/SKILL.md', '---\nname: c\ndescription: Skill C is excluded.\n---\n'),
    ]);
    const mirrorRoot = mkdtempSync(join(tmpdir(), 'skillcheck-pp-'));
    tmpDirs.push(mirrorRoot);
    const db = createTestDb();
    db.prepare("INSERT INTO runs (id, kind, snapshot_date) VALUES ('r1','harvest','2026-08-25')").run();
    const client = mockMonorepo(tarball);

    const result = await harvestRepo(db, client, 'anthropics/claude-code', 'official_marketplace', null, 'r1', mirrorRoot, {
      pathPrefixes: ['plugins/p1', 'plugins/p2', 'plugins/p3'],
    });

    expect(result.skillCount).toBe(2); // a + b; 'other/…' excluded by prefix
    expect(result.perPrefix).toEqual({ 'plugins/p1': 1, 'plugins/p2': 1, 'plugins/p3': 0 });

    const rows = db.prepare('SELECT path, source_detail FROM skills ORDER BY path').all() as {
      path: string;
      source_detail: string | null;
    }[];
    expect(rows.map((r) => r.path)).toEqual(['plugins/p1/skills/a/SKILL.md', 'plugins/p2/skills/b/SKILL.md']);
    expect(rows.find((r) => r.path === 'plugins/p1/skills/a/SKILL.md')!.source_detail).toBe('plugins/p1');
    expect(rows.find((r) => r.path === 'plugins/p2/skills/b/SKILL.md')!.source_detail).toBe('plugins/p2');

    // the mirror only materialized files under the requested prefixes
    expect(existsSync(join(mirrorRoot, 'anthropics__claude-code', 'plugins', 'p1', 'skills', 'a', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(mirrorRoot, 'anthropics__claude-code', 'other', 'skills', 'c', 'SKILL.md'))).toBe(false);
  });

  it('reuses a provided (already-verified) tree instead of calling listTree', async () => {
    const tarball = gzTar([tarFile('acc-sha/plugins/p1/skills/a/SKILL.md', '---\nname: a\ndescription: Skill A does a thing.\n---\n')]);
    const mirrorRoot = mkdtempSync(join(tmpdir(), 'skillcheck-tree-'));
    tmpDirs.push(mirrorRoot);
    const db = createTestDb();
    db.prepare("INSERT INTO runs (id, kind, snapshot_date) VALUES ('r1','harvest','2026-08-25')").run();
    // Tree endpoint THROWS — proves harvestRepo does NOT re-fetch the tree when one is supplied.
    const client = new GitHubClient({
      fetchImpl: (async (url: string) => {
        const u = String(url);
        if (u.includes('/git/trees/')) throw new Error('listTree must not be called when a verified tree is provided');
        if (u.includes('/tarball/')) return makeResponse({ status: 200, buffer: tarball });
        if (/\/repos\/anthropics\/claude-code$/.test(u))
          return makeResponse({
            status: 200,
            body: JSON.stringify({
              full_name: 'anthropics/claude-code',
              stargazers_count: 1,
              pushed_at: '2026-09-01T00:00:00Z',
              archived: false,
              fork: false,
              license: { spdx_id: 'MIT' },
              default_branch: 'main',
            }),
          });
        return makeResponse({ status: 404, body: '{}' });
      }) as unknown as typeof fetch,
    });
    const result = await harvestRepo(db, client, 'anthropics/claude-code', 'official_marketplace', null, 'r1', mirrorRoot, {
      pathPrefixes: ['plugins/p1'],
      tree: { paths: ['plugins/p1/skills/a/SKILL.md'], truncated: false, sha: 'provided-sha' },
    });
    expect(result.skillCount).toBe(1);
    expect(result.perPrefix).toEqual({ 'plugins/p1': 1 });
  });
});
