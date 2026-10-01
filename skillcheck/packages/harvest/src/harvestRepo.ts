import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, parseFrontmatter, type Db } from '@skillcheck/core';
import type { GitHubClient } from './githubClient';
import { extractTarballGz, isUnderPrefix, DEFAULT_LIMITS } from './mirror';
import { upsertSkill, type SourceKind } from './store';

// Harvest all SKILL.md skills from one repo: recursive tree scan → mirror the repo once
// (guarded) → parse each skill's frontmatter from the mirror → upsert. Reused by every
// repo-based source (anthropics/skills, marketplace plugins, community-registry repos).

const isSkillMd = (p: string): boolean => /(^|\/)SKILL\.md$/i.test(p);

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function repoMirrorName(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]/g, '__');
}

export interface HarvestRepoResult {
  skillCount: number;
  mirrored: boolean;
  /** Present only when pathPrefixes was used: SKILL.md count per requested prefix (incl. zeros). */
  perPrefix?: Record<string, number>;
}

export interface HarvestRepoOpts {
  /** Restrict the harvest to SKILL.md files under these in-repo dir prefixes — used to pull only
   *  the plugin dirs out of a large marketplace repo. Attributes source_detail per matching prefix
   *  and mirrors only those dirs. */
  pathPrefixes?: string[];
  /** A pre-fetched, already-verified tree to use instead of re-fetching. The marketplace harvest
   *  passes the same tree it validated (complete, non-truncated) so the local plugin harvest cannot
   *  hit a second, possibly-truncated fetch. */
  tree?: { paths: string[]; truncated: boolean; sha: string | null };
}

/** The longest of `prefixes` that `path` sits under, or null. */
function matchingPrefix(path: string, prefixes: string[]): string | null {
  let best: string | null = null;
  for (const pre of prefixes) {
    if (isUnderPrefix(path, pre) && (best === null || pre.length > best.length)) best = pre;
  }
  return best;
}

export async function harvestRepo(
  db: Db,
  client: GitHubClient,
  repo: string,
  source: SourceKind,
  sourceDetail: string | null,
  runId: string,
  mirrorRoot: string,
  opts: HarvestRepoOpts = {},
): Promise<HarvestRepoResult> {
  const prefixes = (opts.pathPrefixes ?? []).map((p) => p.replace(/\/+$/, '')).filter((p) => p !== '');
  const usingPrefixes = prefixes.length > 0;

  const tree = opts.tree ?? (await client.listTree(repo, 'HEAD'));
  let skillPaths = tree.paths.filter(isSkillMd).sort();
  if (usingPrefixes) skillPaths = skillPaths.filter((p) => prefixes.some((pre) => isUnderPrefix(p, pre)));

  // Per-prefix accounting: every requested prefix gets a count, even zero — a plugin that
  // ships no skills is a recorded fact, never a silent absence.
  let perPrefix: Record<string, number> | undefined;
  if (usingPrefixes) {
    perPrefix = {};
    for (const pre of prefixes) perPrefix[pre] = 0;
    for (const p of skillPaths) {
      const pre = matchingPrefix(p, prefixes);
      if (pre) perPrefix[pre] = (perPrefix[pre] ?? 0) + 1;
    }
  }

  if (skillPaths.length === 0) return { skillCount: 0, mirrored: false, ...(perPrefix ? { perPrefix } : {}) };

  const meta = await client.getRepoMeta(repo);
  const ref = tree.sha ?? meta?.default_branch ?? 'HEAD';
  const safeName = repoMirrorName(repo);
  const destDir = join(mirrorRoot, safeName);

  let mirrored = false;
  const tarball = await client.getTarball(repo, ref);
  if (tarball) {
    extractTarballGz(tarball, destDir, DEFAULT_LIMITS, usingPrefixes ? { includePrefixes: prefixes } : {});
    mirrored = true;
  }

  for (const p of skillPaths) {
    const dir = posixDirname(p);
    const mirrorPath = dir ? `${safeName}/${dir}` : safeName;
    const detail = usingPrefixes ? (matchingPrefix(p, prefixes) ?? sourceDetail) : sourceDetail;

    let frontmatterValid = false;
    let name: string | null = null;
    let description: string | null = null;
    let contentSha256: string | null = null;
    if (mirrored) {
      try {
        const content = readFileSync(join(destDir, p), 'utf8');
        const fm = parseFrontmatter(content);
        frontmatterValid = fm.valid;
        name = fm.frontmatter?.name ?? null;
        description = fm.frontmatter?.description ?? null;
        contentSha256 = sha256Hex(content);
      } catch {
        /* skill file not in mirror (skipped by a guard) — leave as invalid */
      }
    }

    upsertSkill(db, {
      repo,
      path: p,
      source,
      sourceDetail: detail,
      name,
      description,
      frontmatterValid,
      repoStars: meta?.stars ?? null,
      repoPushedAt: meta?.pushed_at ?? null,
      repoArchived: meta?.archived ?? null,
      repoFork: meta?.fork ?? null,
      repoLicense: meta?.license ?? null,
      defaultBranch: meta?.default_branch ?? null,
      headSha: ref,
      contentSha256,
      mirrorPath,
      harvestRunId: runId,
    });
  }

  return { skillCount: skillPaths.length, mirrored, ...(perPrefix ? { perPrefix } : {}) };
}
