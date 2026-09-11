import type { GitHubClient } from './githubClient';

// Mechanical selection of the 3 largest community skill registries, so the cohort is
// auditable and cannot be accused of cherry-picking (plan hole H6). We search by topic and
// "awesome" phrasing, apply a PUBLISHED inclusion predicate (a repo whose primary content
// indexes third-party skills — >= 20 outbound GitHub repo links in its README), then take
// the top 3 by stars. The full candidate list + predicate results are recorded in
// params_json. Web-only scraper registries cannot be star-ranked and are excluded by rule.

export const MIN_OUTBOUND_REPO_LINKS = 20;

/** Count distinct owner/repo links in README text (excluding self-links to `selfRepo`). */
export function outboundRepoLinks(readme: string, selfRepo: string): number {
  const re = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+)/g;
  const set = new Set<string>();
  for (const m of readme.matchAll(re)) {
    const full = m[1]!.replace(/\.git$/, '');
    if (full.toLowerCase() !== selfRepo.toLowerCase()) set.add(full.toLowerCase());
  }
  return set.size;
}

export interface RegistryCandidate {
  full_name: string;
  stars: number;
  description: string | null;
  outboundLinks: number;
  isRegistry: boolean;
}

export interface RegistrySelection {
  candidates: RegistryCandidate[];
  selected: string[];
}

/** Pure selection: keep registries, sort by stars desc (then name), take topN. */
export function selectRegistries(candidates: RegistryCandidate[], topN = 3): RegistrySelection {
  const registries = candidates
    .filter((c) => c.isRegistry)
    .sort((a, b) => b.stars - a.stars || (a.full_name < b.full_name ? -1 : 1));
  return { candidates, selected: registries.slice(0, topN).map((c) => c.full_name) };
}

const SEARCH_QUERIES = ['topic:claude-skills', 'awesome claude skills', 'claude code skills'];

/** Discover + rank candidate registries. Requires auth (repo search). */
export async function discoverRegistries(client: GitHubClient, topN = 3): Promise<RegistrySelection> {
  const seen = new Map<string, { full_name: string; stars: number; description: string | null }>();
  for (const q of SEARCH_QUERIES) {
    for (const r of await client.searchRepos(q, 30)) {
      if (!seen.has(r.full_name)) seen.set(r.full_name, r);
    }
  }

  const candidates: RegistryCandidate[] = [];
  for (const r of seen.values()) {
    let readme = '';
    const res = await client.request(`/repos/${r.full_name}/readme`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    if (res.status === 200) readme = res.text;
    const links = readme ? outboundRepoLinks(readme, r.full_name) : 0;
    candidates.push({
      full_name: r.full_name,
      stars: r.stars,
      description: r.description,
      outboundLinks: links,
      isRegistry: links >= MIN_OUTBOUND_REPO_LINKS,
    });
  }
  candidates.sort((a, b) => b.stars - a.stars || (a.full_name < b.full_name ? -1 : 1));
  return selectRegistries(candidates, topN);
}
