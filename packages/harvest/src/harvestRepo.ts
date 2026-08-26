import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, parseFrontmatter, type Db } from '@skillcheck/core';
import type { GitHubClient } from './githubClient';
import { extractTarballGz } from './mirror';
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
}

export async function harvestRepo(
  db: Db,
  client: GitHubClient,
  repo: string,
  source: SourceKind,
  sourceDetail: string | null,
  runId: string,
  mirrorRoot: string,
): Promise<HarvestRepoResult> {
  const tree = await client.listTree(repo, 'HEAD');
  const skillPaths = tree.paths.filter(isSkillMd).sort();
  if (skillPaths.length === 0) return { skillCount: 0, mirrored: false };

  const meta = await client.getRepoMeta(repo);
  const ref = tree.sha ?? meta?.default_branch ?? 'HEAD';
  const safeName = repoMirrorName(repo);
  const destDir = join(mirrorRoot, safeName);

  let mirrored = false;
  const tarball = await client.getTarball(repo, ref);
  if (tarball) {
    extractTarballGz(tarball, destDir);
    mirrored = true;
  }

  for (const p of skillPaths) {
    const dir = posixDirname(p);
    const mirrorPath = dir ? `${safeName}/${dir}` : safeName;

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
      sourceDetail,
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

  return { skillCount: skillPaths.length, mirrored };
}
