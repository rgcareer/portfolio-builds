// Re-verification: every proposal is checked independently of the probe that found it.
// patch-applies runs for every proposal; a second, category-specific method also runs (per
// checks.json reverify_methods). `pass` requires patch-applies AND the specific method.

import { applyUnifiedDiff, diffAppliesCleanly } from './patch';
import { checkPrereqOnly, type PageCheckInput } from './checks';
import type { Checks } from './protocol';
import type { Evidence, Proposal, ReverifyResult } from './types';
import type { ChainResult, Lookup, RegistryInfo } from './lookup';

export interface GitApplyCheckResult {
  pass: boolean;
  detail: string;
}

export type GitApplyCheckFn = (repo: string, path: string, raw: string, diff: string) => GitApplyCheckResult;

export interface ReverifyDeps {
  lookup: Lookup;
  /** Fresh content for the proposal's page (own-repo: raw markdown; site/external: text.txt). */
  rawContent: string;
  checks: Checks;
  /** Full repo tree listing, for tree-path-exists (own-repo path-rewrite proposals only). */
  tree?: string[];
  /** Runs `git apply --check` against a snapshot copy in $TMPDIR; only consulted for repo-file targets. */
  gitApplyCheck?: GitApplyCheckFn;
}

export interface ReverifyMethodResult {
  method: string;
  pass: boolean;
  evidence: Evidence;
}

const METHODS_FOR_CATEGORY: Record<Proposal['category'], string[]> = {
  'redirect-rewrite': ['http-get-final', 'patch-applies'],
  'pin-bump': ['registry-version-exists', 'patch-applies'],
  'path-rewrite': ['tree-path-exists', 'patch-applies'],
  'prose-prerequisite': ['recheck-patched-text', 'patch-applies'],
};

function methodPatchApplies(proposal: Proposal, deps: ReverifyDeps): ReverifyMethodResult {
  if (!proposal.diff) return { method: 'patch-applies', pass: false, evidence: { reason: 'proposal carries no diff' } };
  const clean = diffAppliesCleanly(deps.rawContent, proposal.diff);
  const applied = clean ? applyUnifiedDiff(deps.rawContent, proposal.diff) : null;
  let gitOk = true;
  let gitDetail: string | null = null;
  if (clean && applied !== null && proposal.target.kind === 'repo-file' && deps.gitApplyCheck) {
    const g = deps.gitApplyCheck(proposal.target.repo ?? '', proposal.target.path, deps.rawContent, proposal.diff);
    gitOk = g.pass;
    gitDetail = g.detail;
  }
  const pass = clean && applied !== null && gitOk;
  return { method: 'patch-applies', pass, evidence: { clean, appliedNonNull: applied !== null, gitOk, gitDetail } };
}

async function methodHttpGetFinal(proposal: Proposal, deps: ReverifyDeps): Promise<ReverifyMethodResult> {
  const finalUrl = (proposal.evidence['finalUrl'] as string | undefined) ?? '';
  const fresh = (await deps.lookup.verify(`link:${finalUrl}`)) as ChainResult;
  const pass = fresh.kind === 'chain' && fresh.error === null && fresh.finalStatus === 200 && fresh.hops.length === 1;
  return { method: 'http-get-final', pass, evidence: { finalUrl, freshChain: fresh } };
}

async function methodRegistryVersionExists(proposal: Proposal, deps: ReverifyDeps): Promise<ReverifyMethodResult> {
  const ecosystem = (proposal.evidence['ecosystem'] as 'npm' | 'pypi' | undefined) ?? 'npm';
  const name = (proposal.evidence['name'] as string | undefined) ?? '';
  const latest = (proposal.evidence['latest'] as string | undefined) ?? '';
  const fresh = (await deps.lookup.verify(`${ecosystem}:${name}`)) as RegistryInfo;
  const pass = fresh.kind === 'registry' && fresh.exists && fresh.versions.includes(latest) && !fresh.deprecatedVersions.includes(latest);
  return { method: 'registry-version-exists', pass, evidence: { name, latest, freshInfo: fresh } };
}

function methodTreePathExists(proposal: Proposal, deps: ReverifyDeps): ReverifyMethodResult {
  const rewrittenTo = (proposal.evidence['rewrittenTo'] as string | undefined) ?? '';
  const pass = (deps.tree ?? []).includes(rewrittenTo);
  return { method: 'tree-path-exists', pass, evidence: { rewrittenTo, treeSize: (deps.tree ?? []).length } };
}

function methodRecheckPatchedText(proposal: Proposal, deps: ReverifyDeps): ReverifyMethodResult {
  if (!proposal.diff) return { method: 'recheck-patched-text', pass: false, evidence: { reason: 'proposal carries no diff' } };
  const patched = applyUnifiedDiff(deps.rawContent, proposal.diff);
  if (patched === null) return { method: 'recheck-patched-text', pass: false, evidence: { reason: 'diff did not apply' } };
  const name = proposal.evidence['name'];
  const baseInput: Omit<PageCheckInput, 'text'> = { pageId: proposal.pageId, links: [], path: null, selfUrl: null };
  const before = checkPrereqOnly({ ...baseInput, text: deps.rawContent }, deps.checks);
  const after = checkPrereqOnly({ ...baseInput, text: patched }, deps.checks);
  const stillFires = after.some((f) => f.evidence['name'] === name);
  const noNewCounted = after.filter((f) => f.counted).length <= before.filter((f) => f.counted).length;
  const pass = !stillFires && noNewCounted;
  return { method: 'recheck-patched-text', pass, evidence: { stillFires, beforeCounted: before.filter((f) => f.counted).length, afterCounted: after.filter((f) => f.counted).length } };
}

export async function reverifyProposal(proposal: Proposal, deps: ReverifyDeps): Promise<ReverifyResult> {
  const methodNames = METHODS_FOR_CATEGORY[proposal.category];
  const results: ReverifyMethodResult[] = [];
  for (const m of methodNames) {
    if (m === 'patch-applies') results.push(methodPatchApplies(proposal, deps));
    else if (m === 'http-get-final') results.push(await methodHttpGetFinal(proposal, deps));
    else if (m === 'registry-version-exists') results.push(await methodRegistryVersionExists(proposal, deps));
    else if (m === 'tree-path-exists') results.push(methodTreePathExists(proposal, deps));
    else if (m === 'recheck-patched-text') results.push(methodRecheckPatchedText(proposal, deps));
  }
  const allPass = results.length > 0 && results.every((r) => r.pass);
  return {
    status: allPass ? 'pass' : 'fail',
    methods: methodNames,
    evidence: { results },
    checkedAt: new Date().toISOString(),
  };
}
