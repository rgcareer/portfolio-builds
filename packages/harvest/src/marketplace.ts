import type { Db } from '@skillcheck/core';
import type { GitHubClient } from './githubClient';
import { harvestRepo } from './harvestRepo';

// The official Claude Code plugin marketplace is a repo carrying
// `.claude-plugin/marketplace.json`. Its exact location/format has shifted during 2025-26,
// so candidates are pinned in ONE place and verified at runtime; "marketplace moved / format
// changed" is a first-class, LOUD outcome (found:false), never a silent zero (plan hole H7).

export const MARKETPLACE_CANDIDATES: { repo: string; path: string }[] = [
  { repo: 'anthropics/claude-code', path: '.claude-plugin/marketplace.json' },
  { repo: 'anthropics/skills', path: '.claude-plugin/marketplace.json' },
];

/** Extract owner/repo refs from a marketplace.json of uncertain shape. */
export function parseMarketplaceRepos(json: unknown): string[] {
  const repos = new Set<string>();
  const addRef = (v: unknown): void => {
    if (typeof v !== 'string') return;
    // accept "owner/repo", "github.com/owner/repo", or a git URL
    const m = /(?:github\.com[/:])?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+)/.exec(v);
    if (m) repos.add(m[1]!.replace(/\.git$/, ''));
  };
  const plugins = (json as { plugins?: unknown })?.plugins;
  if (Array.isArray(plugins)) {
    for (const p of plugins) {
      if (p && typeof p === 'object') {
        const o = p as Record<string, unknown>;
        addRef(o['repo']);
        addRef(o['source']);
        if (o['source'] && typeof o['source'] === 'object') {
          addRef((o['source'] as Record<string, unknown>)['repo']);
          addRef((o['source'] as Record<string, unknown>)['url']);
        }
      } else {
        addRef(p);
      }
    }
  }
  return Array.from(repos).sort();
}

export interface MarketplaceResult {
  found: boolean;
  marketplaceRepo: string | null;
  pluginRepos: string[];
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
    const pluginRepos = parseMarketplaceRepos(json);
    let skillCount = 0;
    for (const repo of pluginRepos) {
      const r = await harvestRepo(db, client, repo, 'official_marketplace', cand.repo, runId, mirrorRoot);
      skillCount += r.skillCount;
    }
    return { found: true, marketplaceRepo: cand.repo, pluginRepos, skillCount };
  }
  return { found: false, marketplaceRepo: null, pluginRepos: [], skillCount: 0 };
}
