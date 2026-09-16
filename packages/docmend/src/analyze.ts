// Aggregation: a pure function of the committed findings.json + proposals.json (produced by
// the scan/propose/verify CLI steps) into run-meta.json. The headline renders ONLY from
// run-meta.json — never from a live recount — so `docmend repro` re-deriving run-meta.json
// bit-for-bit is what proves the published numbers are real.

import { wilsonPctStrings, renderHeadline, SIMULATED, SIMULATED_CONFIDENCE_CAP, type HeadlineValue } from '@portfolio-builds/shared';
import type { Manifest } from './snapshot';
import type { PageFindings, Proposal } from './types';

export interface CorpusStats {
  pages: number;
  own: number;
  repos: number;
  sitePages: number;
  ext: number;
}

export interface DriftStats {
  total: number;
  byCategory: Record<string, number>;
  links: number;
  snippets: number;
  pins: number;
}

export interface ProposalStats {
  proposed: number;
  verified: number;
  safeAuto: number;
  simulatedCount: number;
  pct: { p: string; lo: string; hi: string } | null;
}

export interface LlmStats {
  calls: number;
  errors: number;
  costUsd: number;
  mock: number;
}

export interface RunMeta {
  piece: 'docmend';
  protocolHash: string;
  protocolCommit: string | null;
  corpus: CorpusStats;
  drift: DriftStats;
  proposals: ProposalStats;
  llm: LlmStats;
  generatedAt: string;
}

export function computeRunMeta(manifests: Manifest[], pageFindings: PageFindings[], proposals: Proposal[], llm: LlmStats, protocolHash: string, protocolCommit: string | null): RunMeta {
  const own = manifests.filter((m) => m.source === 'own-repo');
  const repos = new Set(own.map((m) => m.repo).filter((r): r is string => r !== null)).size;
  const sitePages = manifests.filter((m) => m.source === 'site').length;
  const ext = manifests.filter((m) => m.source === 'external').length;

  const byCategory: Record<string, number> = {};
  let total = 0;
  let links = 0;
  let snippets = 0;
  let pins = 0;
  for (const pf of pageFindings) {
    links += pf.stats.linksChecked;
    snippets += pf.stats.snippets;
    pins += pf.stats.pins;
    for (const f of pf.findings) {
      if (!f.counted) continue;
      total++;
      byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    }
  }

  const proposed = proposals.length;
  const verified = proposals.filter((p) => p.reverify.status === 'pass').length;
  const safeAuto = proposals.filter((p) => p.safe_to_auto_apply).length;
  const simulatedCount = proposals.filter((p) => p.independence === SIMULATED).length;
  const pct = proposed > 0 ? wilsonPctStrings(verified, proposed) : null;

  return {
    piece: 'docmend',
    protocolHash,
    protocolCommit,
    corpus: { pages: manifests.length, own: own.length, repos, sitePages, ext },
    drift: { total, byCategory, links, snippets, pins },
    proposals: { proposed, verified, safeAuto, simulatedCount, pct },
    llm,
    generatedAt: new Date().toISOString(),
  };
}

export function headlineValues(m: RunMeta): Record<string, HeadlineValue | null> {
  return {
    pages: m.corpus.pages,
    own: m.corpus.own,
    repos: m.corpus.repos,
    site_pages: m.corpus.sitePages,
    ext: m.corpus.ext,
    links: m.drift.links,
    snippets: m.drift.snippets,
    pins: m.drift.pins,
    drift: m.drift.total,
    proposed: m.proposals.proposed,
    verified: m.proposals.verified,
    p: m.proposals.pct?.p ?? null,
    lo: m.proposals.pct?.lo ?? null,
    hi: m.proposals.pct?.hi ?? null,
  };
}

export function subHeadlineValues(m: RunMeta): Record<string, HeadlineValue | null> {
  return {
    proposed: m.proposals.proposed,
    safeAuto: m.proposals.safeAuto,
    simulatedCount: m.proposals.simulatedCount,
    simulatedTag: SIMULATED,
    cap: SIMULATED_CONFIDENCE_CAP,
  };
}

/**
 * Renders the headline from run-meta.json only. proposed:0 (nothing to verify yet) means
 * pct is null — the generator refuses the percentage sentence and returns `noProposalsText`
 * instead of ever printing an unmeasured number.
 */
export function renderDocmendHeadline(template: string, m: RunMeta, noProposalsText: string): string {
  if (m.proposals.proposed === 0 || m.proposals.pct === null) return noProposalsText;
  return renderHeadline(template, headlineValues(m));
}

export function renderDocmendSubHeadline(template: string, m: RunMeta): string {
  return renderHeadline(template, subHeadlineValues(m));
}
