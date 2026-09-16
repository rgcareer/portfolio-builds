// Mechanical proposal generation ($0, no LLM): redirect-rewrite, pin-bump, path-rewrite.
// Every safety rule here mirrors checks.json's fix_policy verbatim — this module is the
// single place that decides safe_to_auto_apply, so a policy change has exactly one home.
// The fourth proposal category, prose-prerequisite, is LLM-authored and lives in llm.ts.

import type { Finding, Proposal, ProposalTarget } from './types';
import { pendingReverify } from './types';
import type { ChainResult } from './lookup';
import { makeUnifiedDiff } from './patch';

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}

export interface RedirectSafety {
  status: 'safe' | 'unsafe' | 'flag';
  reason: string;
}

const SUSPICIOUS_FINAL_RE = /login|signin|404|not-found/i;

/** Safety classification for a redirect-rewrite proposal, per checks.json fix_policy['redirected-link']. */
export function classifyRedirectSafety(originalUrl: string, chain: ChainResult): RedirectSafety {
  let originalHost: string;
  let originalPath: string;
  try {
    const u = new URL(originalUrl);
    originalHost = u.hostname;
    originalPath = u.pathname;
  } catch {
    return { status: 'flag', reason: 'original URL is not parseable' };
  }
  if (originalPath === '/') return { status: 'flag', reason: 'root redirect: never auto-rewritten, always flagged for review' };

  if (chain.error || chain.finalStatus !== 200) return { status: 'flag', reason: 'chain did not resolve cleanly to a final 200 (broken, not a rewrite candidate)' };

  let finalHost: string;
  let finalPath: string;
  try {
    const fu = new URL(chain.finalUrl);
    finalHost = fu.hostname;
    finalPath = fu.pathname;
  } catch {
    return { status: 'flag', reason: 'final URL is not parseable' };
  }

  const hostUnchanged = finalHost === originalHost;
  const wwwOrSchemeOnlyDiff = !hostUnchanged && stripWww(finalHost) === stripWww(originalHost);
  if (!hostUnchanged && !wwwOrSchemeOnlyDiff) {
    return { status: 'unsafe', reason: `cross-host permanent redirect (${originalHost} -> ${finalHost})` };
  }

  // chain.hops includes the terminal non-redirect response too (walkChain records every
  // fetch); only the actual redirect hops must be permanent — the final 200 is not itself
  // a redirect and is excluded from this check.
  const isRedirectStatus = (s: number | null): boolean => s !== null && s >= 300 && s < 400;
  const allPermanent = chain.hops.every((h) => !isRedirectStatus(h.status) || h.status === 301 || h.status === 308);
  if (!allPermanent) return { status: 'unsafe', reason: 'chain mixes a non-permanent (302/307) hop with a permanent one' };

  if (finalPath === '/') return { status: 'unsafe', reason: 'final path is "/" though the original path was not' };

  if (SUSPICIOUS_FINAL_RE.test(chain.finalUrl)) return { status: 'unsafe', reason: 'final URL looks like a login/404/not-found page' };

  return { status: 'safe', reason: 'every hop is a permanent redirect (301/308) to a same-host, non-root, non-auth final URL' };
}

function mkProposal(finding: Finding, category: Proposal['category'], target: ProposalTarget, safe: boolean, reason: string, diffResult: ReturnType<typeof makeUnifiedDiff>, evidence: Record<string, unknown>, edit: { line: number; old: string; new: string }): Proposal {
  return {
    id: `${finding.id}:${category}`,
    findingId: finding.id,
    pageId: finding.pageId,
    category,
    source: 'mechanical',
    independence: 'measured',
    confidence: null,
    model: null,
    safe_to_auto_apply: safe && diffResult.ok,
    reason: diffResult.ok ? reason : `${reason} (diff refused: ${diffResult.reason})`,
    evidence,
    edit,
    diff: diffResult.ok ? diffResult.diff : null,
    target,
    reverify: pendingReverify(),
  };
}

/** Never proposed for a root redirect or a chain that never reached a final 200 — flag only. */
export function proposeRedirectRewrite(finding: Finding, raw: string, target: ProposalTarget): Proposal | null {
  if (finding.checkId !== 'D-redirect' || !finding.counted) return null;
  const url = finding.evidence['url'] as string | undefined;
  const chain = finding.evidence['chain'] as ChainResult | undefined;
  if (!url || !chain) return null;
  const safety = classifyRedirectSafety(url, chain);
  if (safety.status === 'flag') return null;
  const diffResult = makeUnifiedDiff(raw, url, chain.finalUrl);
  const newLine = finding.excerpt.includes(url) ? finding.excerpt.split(url).join(chain.finalUrl) : chain.finalUrl;
  return mkProposal(finding, 'redirect-rewrite', target, safety.status === 'safe', safety.reason, diffResult, { url, finalUrl: chain.finalUrl, chain }, { line: finding.line, old: finding.excerpt, new: newLine });
}

/** Never proposed when the registry's latest is itself deprecated/yanked — flag only. */
export function proposePinBump(finding: Finding, raw: string, target: ProposalTarget): Proposal | null {
  if (finding.checkId !== 'D-pin') return null;
  const ev = finding.evidence as { ecosystem?: 'npm' | 'pypi'; name?: string; pin?: string; latest?: string; deprecated?: boolean };
  if (!ev.name || !ev.pin || !ev.latest) return null; // the deprecated-only finding carries no pin: flag only
  if (ev.deprecated) return null;
  const oldText = `${ev.name}@${ev.pin}`;
  const newText = `${ev.name}@${ev.latest}`;
  const diffResult = makeUnifiedDiff(raw, oldText, newText);
  const safe = finding.category === 'stale-pin'; // same-major (stale-pin) is safe; major-behind (version-drift) is not
  const reason = safe ? `registry latest (${ev.latest}) shares the pin's major version` : `registry latest (${ev.latest}) is a major version ahead of the pin (${ev.pin}); bump proposed but not auto-applied`;
  const newLine = finding.excerpt.includes(oldText) ? finding.excerpt.split(oldText).join(newText) : newText;
  return mkProposal(finding, 'pin-bump', target, safe, reason, diffResult, { ecosystem: ev.ecosystem ?? 'npm', name: ev.name, pin: ev.pin, latest: ev.latest }, { line: finding.line, old: finding.excerpt, new: newLine });
}

/** Safe iff exactly one tree file shares the broken path's basename; else flag only (candidates in evidence). */
export function proposePathRewrite(finding: Finding, raw: string, target: ProposalTarget): Proposal | null {
  if (finding.checkId !== 'D-rel-path') return null;
  const ev = finding.evidence as { target?: string; resolved?: string; candidates?: string[] };
  if (!ev.target || !ev.candidates || ev.candidates.length !== 1) return null;
  const newPath = ev.candidates[0]!;
  const diffResult = makeUnifiedDiff(raw, ev.target, newPath);
  const newLine = finding.excerpt.includes(ev.target) ? finding.excerpt.split(ev.target).join(newPath) : newPath;
  return mkProposal(finding, 'path-rewrite', target, true, 'exactly one file in the repo tree shares the basename', diffResult, { target: ev.target, resolved: ev.resolved, rewrittenTo: newPath }, { line: finding.line, old: finding.excerpt, new: newLine });
}

/** Dispatches to the right mechanical generator by category, or null for a flag-only / LLM-only finding. */
export function proposeMechanical(finding: Finding, raw: string, target: ProposalTarget): Proposal | null {
  if (finding.checkId === 'D-redirect') return proposeRedirectRewrite(finding, raw, target);
  if (finding.checkId === 'D-pin') return proposePinBump(finding, raw, target);
  if (finding.checkId === 'D-rel-path') return proposePathRewrite(finding, raw, target);
  return null;
}
