// Analysis is a pure function of the committed snapshot (corpus text + manifests), the
// committed lookup cache, and the frozen protocol. It writes findings.json and
// run-meta.json; the headline is rendered only from run-meta.json.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableStringify, wilson, wilsonPctStrings, byteCompare } from '@portfolio-builds/shared';
import type { Protocol } from './protocol';
import type { Manifest } from './snapshot';
import type { Exclusion } from './seed';
import { findMilestone, findTimeClaim } from './l0';
import { runL1, type Finding, type Lookup } from './l1';

export interface PageResult {
  id: string;
  repo: string;
  stars: number;
  probe: string;
  url: string;
  sha256Text: string;
  milestone: { line: number; text: string; patternIndex: number; expectedOutput: string | null } | null;
  timeClaim: { line: number; text: string; value: string; unit: string; where: string } | null;
  needsCredential: boolean;
  l1Passed: boolean;
  findings: Finding[];
  installs: number;
  linksChecked: number;
}

export interface RunMeta {
  piece: 'onboarding-transfer-rate';
  protocolHash: string;
  protocolCommit: string | null;
  seededAt: string | null;
  snapshotDate: string | null;
  n: number;
  targetN: number;
  k0: number;
  n0: number;
  k1: number;
  pct: { p0: string; lo0: string; hi0: string; p1: string; lo1: string; hi1: string } | null;
  timeClaims: number;
  needsCredential: number;
  categories: Record<string, { pages: number; findings: number }>;
  probes: Record<string, number>;
  exclusions: Record<string, number>;
  lookupCacheEntries: number;
  llmCostUsd: number;
  llmCalls: number;
  generatedAt: string;
}

export function readManifests(corpusDir: string): Manifest[] {
  if (!existsSync(corpusDir)) return [];
  return readdirSync(corpusDir)
    .filter((d) => existsSync(resolve(corpusDir, d, 'manifest.json')))
    .sort(byteCompare)
    .map((d) => JSON.parse(readFileSync(resolve(corpusDir, d, 'manifest.json'), 'utf8')) as Manifest);
}

export async function analyzeCorpus(
  protocol: Protocol,
  corpusDir: string,
  lookup: Lookup,
  meta: { protocolCommit: string | null; seededAt: string | null; exclusions: Exclusion[]; targetN: number; lookupCacheEntries: () => number; log?: (s: string) => void },
): Promise<{ pages: PageResult[]; runMeta: RunMeta }> {
  const { checks } = protocol;
  const pages: PageResult[] = [];
  for (const m of readManifests(corpusDir)) {
    const text = readFileSync(resolve(corpusDir, m.id, 'text.txt'), 'utf8');
    const milestone = findMilestone(text, checks);
    const timeClaim = findTimeClaim(text, m.title, checks);
    const l1 = await runL1({ text, links: m.links, selfUrl: m.finalUrl, milestoneLine: milestone?.line ?? null }, checks, lookup);
    const findings: Finding[] = [...l1.findings];
    if (!milestone) findings.unshift({ checkId: 'L0-milestone', category: 'undefined-success', line: 0, excerpt: '', detail: 'no line matches any frozen milestone pattern', counted: false });
    if (!timeClaim) findings.push({ checkId: 'L0-time', category: 'no-time-claim', line: 0, excerpt: '', detail: 'no time-to-first-success claim (informational)', counted: false });
    pages.push({
      id: m.id,
      repo: m.repo,
      stars: m.stars,
      probe: m.probe,
      url: m.url,
      sha256Text: m.sha256Text,
      milestone,
      timeClaim,
      needsCredential: l1.needsCredential,
      l1Passed: l1.passed,
      findings,
      installs: l1.installs.length,
      linksChecked: l1.linksChecked,
    });
    meta.log?.(`${m.id} ${m.repo}: milestone=${milestone ? 'yes' : 'no'} l1=${l1.passed ? 'pass' : 'fail'} findings=${findings.filter((f) => f.counted).length}`);
  }

  const n = pages.length;
  const k0 = pages.filter((p) => p.milestone).length;
  const k1 = pages.filter((p) => p.milestone && p.l1Passed).length;
  const categories: RunMeta['categories'] = {};
  for (const p of pages) {
    const seen = new Set<string>();
    for (const f of p.findings) {
      const c = (categories[f.category] ??= { pages: 0, findings: 0 });
      c.findings++;
      if (!seen.has(f.category)) {
        seen.add(f.category);
        c.pages++;
      }
    }
  }
  const probes: Record<string, number> = {};
  for (const p of pages) probes[p.probe] = (probes[p.probe] ?? 0) + 1;
  const exclusions: Record<string, number> = {};
  for (const e of meta.exclusions) exclusions[e.reason] = (exclusions[e.reason] ?? 0) + 1;

  let pct: RunMeta['pct'] = null;
  if (n > 0 && k0 > 0) {
    const a = wilsonPctStrings(k0, n);
    const b = wilsonPctStrings(k1, k0);
    pct = { p0: a.p, lo0: a.lo, hi0: a.hi, p1: b.p, lo1: b.lo, hi1: b.hi };
  } else if (n > 0) {
    const a = wilsonPctStrings(k0, n);
    pct = { p0: a.p, lo0: a.lo, hi0: a.hi, p1: '0.0', lo1: '0.0', hi1: '0.0' };
    void wilson;
  }
  const dates = readManifests(corpusDir).map((m) => m.fetchedAt.slice(0, 10)).sort();
  const runMeta: RunMeta = {
    piece: 'onboarding-transfer-rate',
    protocolHash: protocol.hash,
    protocolCommit: meta.protocolCommit,
    seededAt: meta.seededAt,
    snapshotDate: dates.length ? dates[dates.length - 1]! : null,
    n,
    targetN: meta.targetN,
    k0,
    n0: k0,
    k1,
    pct,
    timeClaims: pages.filter((p) => p.timeClaim).length,
    needsCredential: pages.filter((p) => p.needsCredential).length,
    categories,
    probes,
    exclusions,
    lookupCacheEntries: meta.lookupCacheEntries(),
    llmCostUsd: 0,
    llmCalls: 0,
    generatedAt: new Date().toISOString(),
  };
  return { pages, runMeta };
}

export function writeAnalysis(dataDir: string, pages: PageResult[], runMeta: RunMeta): void {
  writeFileSync(resolve(dataDir, 'findings.json'), stableStringify(pages));
  writeFileSync(resolve(dataDir, 'run-meta.json'), stableStringify(runMeta));
}
