import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@skillcheck/core';
import { GitHubClient } from '../src/githubClient';
import { parseMarketplaceRepos, harvestMarketplace } from '../src/marketplace';
import { tarFile, gzTar, makeResponse } from './helpers';

// ---------------------------------------------------------------------------
// parseMarketplaceRepos — discriminated classification
//
// The marketplace-undercount bug (D-027): the old parser ran an unanchored
// `owner/repo` regex over every plugin entry, so an in-repo relative source
// like `./plugins/code-review` or a bare `plugins/code-review` was misread as
// the external repo `plugins/code-review`, 404'd, and silently contributed 0
// skills. The fix returns discriminated buckets and resolves the ambiguous
// bare case against the marketplace repo's OWN tree.
// ---------------------------------------------------------------------------

describe('parseMarketplaceRepos — classification', () => {
  it('classifies an external github-object source as external', () => {
    const json = { plugins: [{ name: 'ext', source: { source: 'github', repo: 'owner/ext-repo' } }] };
    const r = parseMarketplaceRepos(json, []);
    expect(r.externalRepos).toEqual(['owner/ext-repo']);
    expect(r.localPaths).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });

  it('classifies a `./`-relative string source as a local in-repo path', () => {
    const json = { plugins: [{ name: 'cr', source: './plugins/code-review' }] };
    const r = parseMarketplaceRepos(json, []);
    expect(r.localPaths).toEqual(['plugins/code-review']);
    expect(r.externalRepos).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });

  it('resolves a bare in-repo path against the marketplace tree as LOCAL (the bug case)', () => {
    const json = { plugins: [{ name: 'cr', source: 'plugins/code-review' }] };
    const tree = ['README.md', 'plugins/code-review/skills/foo/SKILL.md'];
    const r = parseMarketplaceRepos(json, tree);
    expect(r.localPaths).toEqual(['plugins/code-review']);
    expect(r.externalRepos).toEqual([]); // MUST NOT be treated as owner/repo → no /repos/plugins/ 404
  });

  it('classifies a bare owner/repo NOT present in the tree as external', () => {
    const json = { plugins: [{ source: 'someowner/somerepo' }] };
    const r = parseMarketplaceRepos(json, ['README.md', 'plugins/x/skills/y/SKILL.md']);
    expect(r.externalRepos).toEqual(['someowner/somerepo']);
    expect(r.localPaths).toEqual([]);
  });

  it('extracts owner/repo from github URLs and bare object repos (external)', () => {
    const json = {
      plugins: [
        { name: 'p1', source: 'owner/repo-one' },
        { name: 'p2', repo: 'https://github.com/owner/repo-two' },
        { name: 'p3', source: { repo: 'owner/repo-three' } },
        'owner/repo-four',
      ],
    };
    const r = parseMarketplaceRepos(json, []);
    expect(r.externalRepos).toEqual(['owner/repo-four', 'owner/repo-one', 'owner/repo-three', 'owner/repo-two']);
    expect(r.localPaths).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });

  it('records an unclassifiable entry as unresolved — never silently dropped', () => {
    const json = { plugins: [{ name: 'weird', source: 12345 }] };
    const r = parseMarketplaceRepos(json, []);
    expect(r.unresolved).toEqual(['weird']);
    expect(r.externalRepos).toEqual([]);
    expect(r.localPaths).toEqual([]);
  });

  it('returns empty buckets for a shapeless blob', () => {
    const r = parseMarketplaceRepos({ nope: 1 }, []);
    expect(r).toEqual({ externalRepos: [], localPaths: [], unresolved: [] });
  });

  it('surfaces a non-array `plugins` container as unresolved (loud format-shift, not a silent zero)', () => {
    const r = parseMarketplaceRepos({ plugins: { 'code-review': './plugins/code-review' } }, []);
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(r.externalRepos).toEqual([]);
    expect(r.localPaths).toEqual([]);
  });

  it('tree-resolves an object-source bare repo (no github marker) to LOCAL, not external', () => {
    const json = { plugins: [{ name: 'obj-local', source: { repo: 'plugins/code-review' } }] };
    const r = parseMarketplaceRepos(json, ['plugins/code-review/skills/x/SKILL.md']);
    expect(r.localPaths).toEqual(['plugins/code-review']);
    expect(r.externalRepos).toEqual([]); // must NOT become /repos/plugins/code-review
  });
});

describe('parseMarketplaceRepos — totality (property: no silent drop)', () => {
  // Property: every plugin entry lands in EXACTLY ONE bucket. With each entry
  // carrying a unique ref, |external| + |local| + |unresolved| === |plugins|.
  // We enumerate every tuple of the five canonical shapes for lengths 1..3
  // (5^1 + 5^2 + 5^3 = 155 cases) — exhaustive over shape-space, deterministic.
  const tree = [
    'plugins/local-0/skills/a/SKILL.md',
    'plugins/local-1/skills/b/SKILL.md',
    'plugins/local-2/skills/c/SKILL.md',
  ];
  function entryFor(shapeIdx: number, pos: number): unknown {
    switch (shapeIdx) {
      case 0:
        return { name: `e${pos}`, source: { source: 'github', repo: `own/ext${pos}` } }; // external object
      case 1:
        return { name: `u${pos}`, source: `https://github.com/own/url${pos}` }; // external url
      case 2:
        return { name: `r${pos}`, source: `./plugins/rel${pos}` }; // local relative
      case 3:
        return { name: `b${pos}`, source: `plugins/local-${pos}` }; // local bare, tree-resolved
      default:
        return { name: `w${pos}`, source: 12345 + pos }; // unresolved
    }
  }
  function* tuples(n: number): Generator<number[]> {
    if (n === 0) {
      yield [];
      return;
    }
    for (const rest of tuples(n - 1)) for (let i = 0; i < 5; i++) yield [i, ...rest];
  }

  it('|external| + |local| + |unresolved| equals the plugin count for every shape tuple', () => {
    let cases = 0;
    for (let len = 1; len <= 3; len++) {
      for (const tup of tuples(len)) {
        const plugins = tup.map((shapeIdx, pos) => entryFor(shapeIdx, pos));
        const r = parseMarketplaceRepos({ plugins }, tree);
        const total = r.externalRepos.length + r.localPaths.length + r.unresolved.length;
        expect(total).toBe(len);
        cases++;
      }
    }
    expect(cases).toBe(5 + 25 + 125);
  });
});

// ---------------------------------------------------------------------------
// harvestMarketplace — end-to-end over a mock marketplace repo
// ---------------------------------------------------------------------------

const MARKETPLACE_JSON = JSON.stringify({
  name: 'claude-code',
  plugins: [
    { name: 'code-review', source: './plugins/code-review' }, // local relative
    { name: 'commit', source: 'plugins/commit' }, // local bare (tree-resolved)
    { name: 'empty-plugin', source: './plugins/empty-plugin' }, // local, zero skills (accounting)
    { name: 'ext', source: { source: 'github', repo: 'ext-owner/ext-plugin' } }, // external
    { name: 'weird', source: 12345 }, // unresolved
  ],
});

function marketplaceMock(opts: { throwOnPlugins?: boolean; treeStatus?: number; treeTruncated?: boolean } = {}): GitHubClient {
  const mktTree = {
    sha: 'mktsha',
    truncated: Boolean(opts.treeTruncated),
    tree: [
      { path: '.claude-plugin/marketplace.json', type: 'blob' },
      { path: 'plugins/code-review/skills/cr/SKILL.md', type: 'blob' },
      { path: 'plugins/commit/skills/cm/SKILL.md', type: 'blob' },
      { path: 'plugins/empty-plugin/README.md', type: 'blob' },
    ],
  };
  const mktRepo = {
    full_name: 'anthropics/claude-code',
    stargazers_count: 1000,
    pushed_at: '2026-09-01T00:00:00Z',
    archived: false,
    fork: false,
    license: { spdx_id: 'MIT' },
    default_branch: 'main',
  };
  const mktTarball = gzTar([
    tarFile('anthropics-claude-code-sha/.claude-plugin/marketplace.json', MARKETPLACE_JSON),
    tarFile(
      'anthropics-claude-code-sha/plugins/code-review/skills/cr/SKILL.md',
      '---\nname: code-review\ndescription: Review a diff for issues.\n---\n# CR\n',
    ),
    tarFile(
      'anthropics-claude-code-sha/plugins/commit/skills/cm/SKILL.md',
      '---\nname: commit\ndescription: Craft a commit message.\n---\n# CM\n',
    ),
    tarFile('anthropics-claude-code-sha/plugins/empty-plugin/README.md', 'no skills here'),
  ]);
  const extTree = { sha: 'extsha', truncated: false, tree: [{ path: 'skills/e/SKILL.md', type: 'blob' }] };
  const extRepo = {
    full_name: 'ext-owner/ext-plugin',
    stargazers_count: 7,
    pushed_at: '2026-07-01T00:00:00Z',
    archived: false,
    fork: false,
    license: { spdx_id: 'Apache-2.0' },
    default_branch: 'main',
  };
  const extTarball = gzTar([
    tarFile('ext-owner-ext-plugin-sha/skills/e/SKILL.md', '---\nname: ext-skill\ndescription: An external plugin skill.\n---\n# E\n'),
  ]);

  return new GitHubClient({
    fetchImpl: (async (url: string) => {
      const u = String(url);
      if (opts.throwOnPlugins && /\/repos\/plugins\//.test(u)) {
        throw new Error(`REGRESSION: relative plugin path requested as a repo: ${u}`);
      }
      if (u.includes('/repos/anthropics/claude-code/contents/.claude-plugin/marketplace.json')) {
        return makeResponse({ status: 200, body: MARKETPLACE_JSON });
      }
      if (u.includes('/repos/anthropics/claude-code/git/trees/')) {
        if (opts.treeStatus && opts.treeStatus !== 200) return makeResponse({ status: opts.treeStatus, body: '{}' });
        return makeResponse({ status: 200, body: JSON.stringify(mktTree) });
      }
      if (u.includes('/repos/ext-owner/ext-plugin/git/trees/')) return makeResponse({ status: 200, body: JSON.stringify(extTree) });
      if (u.includes('/repos/anthropics/claude-code/tarball/')) return makeResponse({ status: 200, buffer: mktTarball });
      if (u.includes('/repos/ext-owner/ext-plugin/tarball/')) return makeResponse({ status: 200, buffer: extTarball });
      if (/\/repos\/anthropics\/claude-code$/.test(u)) return makeResponse({ status: 200, body: JSON.stringify(mktRepo) });
      if (/\/repos\/ext-owner\/ext-plugin$/.test(u)) return makeResponse({ status: 200, body: JSON.stringify(extRepo) });
      return makeResponse({ status: 404, body: '{}' }); // incl. the anthropics/skills candidate
    }) as unknown as typeof fetch,
  });
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshRun() {
  const db = createTestDb();
  db.prepare("INSERT INTO runs (id, kind, snapshot_date) VALUES ('r1','harvest','2026-08-25')").run();
  const mirrorRoot = mkdtempSync(join(tmpdir(), 'skillcheck-mkt-'));
  tmpDirs.push(mirrorRoot);
  return { db, mirrorRoot };
}

describe('harvestMarketplace', () => {
  it('harvests skills from local plugin dirs AND external repos (undercount fix)', async () => {
    const { db, mirrorRoot } = freshRun();
    const result = await harvestMarketplace(db, marketplaceMock(), 'r1', mirrorRoot);

    expect(result.found).toBe(true);
    expect(result.marketplaceRepo).toBe('anthropics/claude-code');
    expect(result.localPaths).toEqual(['plugins/code-review', 'plugins/commit', 'plugins/empty-plugin']);
    expect(result.externalRepos).toEqual(['ext-owner/ext-plugin']);
    expect(result.unresolved).toEqual(['weird']);
    // 2 local (code-review, commit) + 0 (empty-plugin) + 1 external = 3
    expect(result.skillCount).toBe(3);

    const rows = db.prepare('SELECT path, source, source_detail FROM skills ORDER BY path').all() as {
      path: string;
      source: string;
      source_detail: string | null;
    }[];
    expect(rows).toHaveLength(3);
    const cr = rows.find((r) => r.path === 'plugins/code-review/skills/cr/SKILL.md')!;
    expect(cr.source).toBe('official_marketplace');
    expect(cr.source_detail).toBe('plugins/code-review'); // attributed to the plugin dir
    const e = rows.find((r) => r.path === 'skills/e/SKILL.md')!;
    expect(e.source).toBe('official_marketplace');
    expect(e.source_detail).toBe('ext-owner/ext-plugin');
  });

  it('NEVER requests a relative plugin path as a repo (regression guard)', async () => {
    const { db, mirrorRoot } = freshRun();
    // mock THROWS on any /repos/plugins/… request — the exact old-bug shape.
    await expect(harvestMarketplace(db, marketplaceMock({ throwOnPlugins: true }), 'r1', mirrorRoot)).resolves.toMatchObject({
      found: true,
      skillCount: 3,
    });
  });

  it('records per-plugin accounting incl. a zero-skill plugin as a fact', async () => {
    const { db, mirrorRoot } = freshRun();
    const result = await harvestMarketplace(db, marketplaceMock(), 'r1', mirrorRoot);
    const empty = result.perPlugin.find((p) => p.entry === 'plugins/empty-plugin')!;
    expect(empty).toEqual({ entry: 'plugins/empty-plugin', kind: 'local', skillCount: 0 });
    const ext = result.perPlugin.find((p) => p.entry === 'ext-owner/ext-plugin')!;
    expect(ext).toEqual({ entry: 'ext-owner/ext-plugin', kind: 'external', skillCount: 1 });
  });

  // Finding 1: the bare-path resolution depends on a complete marketplace tree. A failed or
  // truncated tree must FAIL LOUD, never let bare plugin paths fall through to external 404s
  // (that is exactly the D-027 silent-undercount bug).
  it('throws (LOUD) when the marketplace tree fetch fails — never silently reverts to external 404s', async () => {
    const { db, mirrorRoot } = freshRun();
    await expect(harvestMarketplace(db, marketplaceMock({ treeStatus: 500 }), 'r1', mirrorRoot)).rejects.toThrow(
      /tree.*(unavailable|truncated|null)/i,
    );
  });

  it('throws (LOUD) when the marketplace tree is truncated', async () => {
    const { db, mirrorRoot } = freshRun();
    await expect(harvestMarketplace(db, marketplaceMock({ treeTruncated: true }), 'r1', mirrorRoot)).rejects.toThrow(
      /truncat/i,
    );
  });
});
