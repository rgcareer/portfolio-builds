import type { Db } from '@skillcheck/core';
import type { GitHubClient } from './githubClient';
import { harvestRepo } from './harvestRepo';
import { isUnderPrefix } from './mirror';

// The official Claude Code plugin marketplace is a repo carrying
// `.claude-plugin/marketplace.json`. Its exact location/format has shifted during 2025-26,
// so candidates are pinned in ONE place and verified at runtime; "marketplace moved / format
// changed" is a first-class, LOUD outcome (found:false), never a silent zero (plan hole H7).

export const MARKETPLACE_CANDIDATES: { repo: string; path: string }[] = [
  { repo: 'anthropics/claude-code', path: '.claude-plugin/marketplace.json' },
  { repo: 'anthropics/skills', path: '.claude-plugin/marketplace.json' },
];

// owner/repo shape (GitHub limits: owner ≤39 chars). repo charset is permissive on purpose.
const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/;
// owner/repo out of a github.com web/ssh/git URL.
const GH_URL = /github\.com[/:]([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+?)(?:\.git)?(?:$|[/#?])/;
const stripGit = (s: string): string => s.replace(/\.git$/, '');
const looksLikeUrl = (s: string): boolean => /github\.com/.test(s) || /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(s);

function extractUrlRepo(s: string): string | null {
  const m = GH_URL.exec(s);
  return m ? m[1]! : null;
}

/** Normalize a declared in-repo path; reject traversal/absolute. Returns null if unsafe. */
function normalizeLocal(s: string): string | null {
  const p = s.replace(/^\.\//, '').replace(/\/+$/, '');
  if (p === '' || p.startsWith('/')) return null;
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  return p;
}

/** True when `prefix` is a directory present in the marketplace repo's own tree. */
function isDirInTree(prefix: string, treePaths: string[]): boolean {
  return treePaths.some((tp) => isUnderPrefix(tp, prefix));
}

/** A short, stable identifier for an unclassifiable entry — for logging + params_json. */
function describeEntry(o: Record<string, unknown>): string {
  if (typeof o['name'] === 'string' && o['name']) return o['name'];
  return JSON.stringify(o).slice(0, 120);
}

interface Buckets {
  externalRepos: Set<string>;
  localPaths: Set<string>;
  unresolved: Set<string>;
}

/** Classify a single string source ref against the marketplace tree. */
function classifyString(s: string, treePaths: string[], b: Buckets): void {
  if (looksLikeUrl(s)) {
    const r = extractUrlRepo(s);
    if (r) b.externalRepos.add(stripGit(r));
    else b.unresolved.add(s);
    return;
  }
  if (s.startsWith('./') || s.startsWith('../')) {
    const n = normalizeLocal(s);
    if (n) b.localPaths.add(n);
    else b.unresolved.add(s);
    return;
  }
  // Bare, scheme-less: resolve the ambiguous case against the marketplace repo's own tree.
  const n = s.replace(/\/+$/, '');
  if (isDirInTree(n, treePaths)) {
    b.localPaths.add(n);
    return;
  }
  if (OWNER_REPO.test(n)) {
    b.externalRepos.add(stripGit(n));
    return;
  }
  b.unresolved.add(s);
}

/** Classify one plugin entry (string or object) into exactly one bucket — never dropped. */
function classifyEntry(entry: unknown, treePaths: string[], b: Buckets): void {
  if (typeof entry === 'string') {
    classifyString(entry, treePaths, b);
    return;
  }
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    const src = o['source'];
    if (src && typeof src === 'object') {
      const so = src as Record<string, unknown>;
      const kind = typeof so['source'] === 'string' ? (so['source'] as string) : undefined;
      if (typeof so['url'] === 'string') {
        const r = extractUrlRepo(so['url']);
        if (r) {
          b.externalRepos.add(r);
          return;
        }
      }
      if (typeof so['repo'] === 'string') {
        // An explicit github/git source (or a URL) is definitively external; a bare repo string
        // WITHOUT such a marker is ambiguous and could be an in-repo path, so resolve it against
        // the tree like a string source — {repo:'plugins/x'} must never become a /repos/plugins/x 404.
        if (kind === 'github' || kind === 'git' || looksLikeUrl(so['repo'])) {
          const r = looksLikeUrl(so['repo']) ? extractUrlRepo(so['repo']) : so['repo'];
          if (r && OWNER_REPO.test(r)) {
            b.externalRepos.add(stripGit(r));
            return;
          }
        } else {
          classifyString(so['repo'], treePaths, b);
          return;
        }
      }
      if (typeof so['path'] === 'string') {
        classifyString(so['path'], treePaths, b);
        return;
      }
      b.unresolved.add(describeEntry(o));
      return;
    }
    if (typeof src === 'string') {
      classifyString(src, treePaths, b);
      return;
    }
    if (typeof o['repo'] === 'string') {
      classifyString(o['repo'], treePaths, b);
      return;
    }
    b.unresolved.add(describeEntry(o));
    return;
  }
  // number / boolean / null → unresolved, surfaced for a human
  b.unresolved.add(String(entry));
}

export interface MarketplaceParse {
  /** Genuine owner/repo refs to harvest individually. */
  externalRepos: string[];
  /** In-repo plugin dir prefixes to harvest from the marketplace repo itself. */
  localPaths: string[];
  /** Shapes we could not classify — recorded + logged, never silently dropped. */
  unresolved: string[];
}

/**
 * Parse a marketplace.json of uncertain shape into discriminated buckets. Pass the marketplace
 * repo's own tree paths so bare in-repo paths (e.g. `plugins/code-review`) resolve to LOCAL
 * instead of being misread as the external repo `plugins/code-review` (the D-027 undercount bug).
 */
export function parseMarketplaceRepos(json: unknown, marketplaceTreePaths: string[] = []): MarketplaceParse {
  const b: Buckets = { externalRepos: new Set(), localPaths: new Set(), unresolved: new Set() };
  const plugins = (json as { plugins?: unknown })?.plugins;
  if (Array.isArray(plugins)) {
    for (const p of plugins) classifyEntry(p, marketplaceTreePaths, b);
  } else if (plugins !== undefined) {
    // `plugins` is present but not an array — a container-level format shift. H7: surface it
    // loudly, never return a silent-zero cohort.
    b.unresolved.add('__plugins_not_an_array__');
  }
  return {
    externalRepos: [...b.externalRepos].sort(),
    localPaths: [...b.localPaths].sort(),
    unresolved: [...b.unresolved].sort(),
  };
}

export interface MarketplaceResult {
  found: boolean;
  marketplaceRepo: string | null;
  /** All harvested refs (external repos + local plugin dirs), sorted. */
  pluginRepos: string[];
  externalRepos: string[];
  localPaths: string[];
  unresolved: string[];
  /** Per-plugin skill counts — a zero is a recorded fact, not an absence. */
  perPlugin: { entry: string; kind: 'external' | 'local'; skillCount: number }[];
  skillCount: number;
}

export async function harvestMarketplace(
  db: Db,
  client: GitHubClient,
  runId: string,
  mirrorRoot: string,
): Promise<MarketplaceResult> {
  for (const cand of MARKETPLACE_CANDIDATES) {
    const res = await client.request(`/repos/${cand.repo}/contents/${cand.path}`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    if (res.status !== 200 || !res.text) continue;
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      continue;
    }

    // Resolve ambiguous bare paths against the marketplace repo's OWN tree. This tree is the
    // linchpin of the fix (bare `plugins/<name>` → local), so an unavailable or truncated tree
    // must FAIL LOUD: letting bare paths fall through to external 404s IS the D-027 bug (H7).
    const tree = await client.listTree(cand.repo, 'HEAD');
    if (tree.sha === null || tree.truncated) {
      throw new Error(
        `marketplace tree for ${cand.repo} is ${tree.sha === null ? 'unavailable' : 'truncated'} ` +
          `(sha=${tree.sha ?? 'null'}, truncated=${tree.truncated}); cannot safely resolve in-repo ` +
          `plugin paths — aborting rather than risk a silent undercount (D-027).`,
      );
    }
    const parsed = parseMarketplaceRepos(json, tree.paths);

    const perPlugin: MarketplaceResult['perPlugin'] = [];
    let skillCount = 0;

    // External plugin repos: one harvestRepo each (genuine owner/repo).
    for (const repo of parsed.externalRepos) {
      const r = await harvestRepo(db, client, repo, 'official_marketplace', repo, runId, mirrorRoot);
      perPlugin.push({ entry: repo, kind: 'external', skillCount: r.skillCount });
      skillCount += r.skillCount;
    }

    // Local plugin dirs: ONE harvestRepo on the marketplace repo, restricted to those dirs —
    // never a per-dir `/repos/<dir>` request (that was the silent-zero bug).
    if (parsed.localPaths.length > 0) {
      const r = await harvestRepo(db, client, cand.repo, 'official_marketplace', null, runId, mirrorRoot, {
        pathPrefixes: parsed.localPaths,
        tree, // reuse the verified tree — no re-fetch, guaranteed complete + consistent
      });
      const per = r.perPrefix ?? {};
      for (const dir of parsed.localPaths) perPlugin.push({ entry: dir, kind: 'local', skillCount: per[dir] ?? 0 });
      skillCount += r.skillCount;
    }

    perPlugin.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
    const pluginRepos = [...parsed.externalRepos, ...parsed.localPaths].sort();
    return {
      found: true,
      marketplaceRepo: cand.repo,
      pluginRepos,
      externalRepos: parsed.externalRepos,
      localPaths: parsed.localPaths,
      unresolved: parsed.unresolved,
      perPlugin,
      skillCount,
    };
  }
  return {
    found: false,
    marketplaceRepo: null,
    pluginRepos: [],
    externalRepos: [],
    localPaths: [],
    unresolved: [],
    perPlugin: [],
    skillCount: 0,
  };
}
