import { describe, it, expect } from 'vitest';
import { computeRunMeta, renderDocmendHeadline, renderDocmendSubHeadline, type LlmStats } from '../src/analyze';
import { loadProtocol } from '../src/protocol';
import type { Manifest } from '../src/snapshot';
import type { PageFindings, Proposal, Finding } from '../src/types';
import { resolve } from 'node:path';

const protocol = loadProtocol(resolve(__dirname, '..', 'protocol'));
const NO_LLM: LlmStats = { calls: 0, errors: 0, costUsd: 0, mock: 0 };

function manifest(overrides: Partial<Manifest>): Manifest {
  return { pageId: 'p1', source: 'own-repo', sourceId: 'repo-a', repo: 'repo-a', path: 'README.md', url: null, kind: 'markdown', rawFile: 'raw.md', bytes: 10, sha256Raw: 'x', sha256Text: 'y', title: null, links: [], fetchedAt: '2026-01-01T00:00:00Z', ...overrides };
}

function finding(overrides: Partial<Finding>): Finding {
  return { id: 'f1', pageId: 'p1', checkId: 'D-link', category: 'broken-link', line: 1, excerpt: 'x', detail: 'x', counted: true, evidence: {}, ...overrides };
}

function pageFindings(overrides: Partial<PageFindings>): PageFindings {
  return { pageId: 'p1', source: 'own-repo', repo: 'repo-a', path: 'README.md', findings: [], stats: { installs: 0, pins: 0, snippets: 0, linksChecked: 0 }, ...overrides };
}

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: 'pr1',
    findingId: 'f1',
    pageId: 'p1',
    category: 'redirect-rewrite',
    source: 'mechanical',
    independence: 'measured',
    confidence: null,
    model: null,
    safe_to_auto_apply: true,
    reason: 'x',
    evidence: {},
    edit: { line: 1, old: 'a', new: 'b' },
    diff: '--- a\n+++ a\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    target: { kind: 'repo-file', repo: 'repo-a', path: 'README.md', prReady: true },
    reverify: { status: 'pass', methods: ['patch-applies'], evidence: {}, checkedAt: '2026-01-01T00:00:00Z' },
    ...overrides,
  };
}

describe('computeRunMeta: aggregation determinism', () => {
  it('counts pages, repos, and drift categories correctly from committed data', () => {
    const manifests = [
      manifest({ pageId: 'a', source: 'own-repo', repo: 'repo-a', path: 'README.md' }),
      manifest({ pageId: 'b', source: 'own-repo', repo: 'repo-b', path: 'README.md' }),
      manifest({ pageId: 'c', source: 'site', repo: null, sourceId: 'getsmartai', path: 'https://getsmartai.ai/' }),
      manifest({ pageId: 'd', source: 'external', repo: null, sourceId: 'otr-quickstarts', path: 'q_1' }),
    ];
    const findings = [
      pageFindings({ pageId: 'a', findings: [finding({ pageId: 'a', category: 'broken-link', counted: true }), finding({ pageId: 'a', category: 'placeholder-text', counted: true })], stats: { installs: 1, pins: 1, snippets: 2, linksChecked: 3 } }),
      pageFindings({ pageId: 'b', findings: [finding({ pageId: 'b', category: 'broken-link', counted: true }), finding({ pageId: 'b', category: 'redirected-link', counted: false })], stats: { installs: 0, pins: 0, snippets: 1, linksChecked: 2 } }),
    ];
    const proposals = [proposal({}), proposal({ id: 'pr2', reverify: { status: 'fail', methods: [], evidence: {}, checkedAt: null } })];

    const m1 = computeRunMeta(manifests, findings, proposals, NO_LLM, protocol.hash, 'abc123');
    expect(m1.corpus).toEqual({ pages: 4, own: 2, repos: 2, sitePages: 1, ext: 1 });
    // 3 counted findings total (2 on page a, 1 on page b); the informational redirect on b does not count.
    expect(m1.drift.total).toBe(3);
    expect(m1.drift.byCategory).toEqual({ 'broken-link': 2, 'placeholder-text': 1 });
    expect(m1.drift.links).toBe(5);
    expect(m1.drift.snippets).toBe(3);
    expect(m1.drift.pins).toBe(1);
    expect(m1.proposals.proposed).toBe(2);
    expect(m1.proposals.verified).toBe(1);

    // Determinism: identical inputs (down to generatedAt being the only expected difference) recompute identically.
    const m2 = computeRunMeta(manifests, findings, proposals, NO_LLM, protocol.hash, 'abc123');
    const strip = (m: typeof m1) => ({ ...m, generatedAt: '<ignored>' });
    expect(strip(m1)).toEqual(strip(m2));
  });
});

describe('renderDocmendHeadline: headline-from-run-meta only', () => {
  it('renders the frozen template filled entirely from run-meta fields', () => {
    const manifests = [manifest({ pageId: 'a' })];
    const findings = [pageFindings({ pageId: 'a', stats: { installs: 0, pins: 0, snippets: 2, linksChecked: 5 } })];
    const proposals = [proposal({}), proposal({ id: 'pr2', reverify: { status: 'fail', methods: [], evidence: {}, checkedAt: null } })];
    const meta = computeRunMeta(manifests, findings, proposals, NO_LLM, protocol.hash, null);
    const sentence = renderDocmendHeadline(protocol.checks.headline_template, meta, protocol.checks.no_proposals_text);
    expect(sentence).toContain('1 documentation pages');
    expect(sentence).toContain('2 fixes proposed');
    expect(sentence).toContain('95% Wilson CI');
    expect(sentence).not.toContain('{'); // no unresolved placeholder
  });

  it('the sub-headline reports safeToAutoApply and [SIMULATED] counts separately from the headline', () => {
    const manifests = [manifest({ pageId: 'a' })];
    const findings = [pageFindings({ pageId: 'a' })];
    const proposals = [proposal({ safe_to_auto_apply: true }), proposal({ id: 'pr2', independence: '[SIMULATED]', confidence: 0.7, safe_to_auto_apply: false })];
    const meta = computeRunMeta(manifests, findings, proposals, NO_LLM, protocol.hash, null);
    const sub = renderDocmendSubHeadline(protocol.checks.sub_headline_template, meta);
    expect(sub).toContain('1 are safe to auto-apply');
    expect(sub).toContain('1 finding(s) rely on an LLM judgment');
    expect(sub).toContain('[SIMULATED]');
  });
});

describe('refusal at proposed=0', () => {
  it('renderDocmendHeadline returns the not-yet-measured text instead of a headline with no proposals', () => {
    const manifests = [manifest({ pageId: 'a' })];
    const findings = [pageFindings({ pageId: 'a' })];
    const meta = computeRunMeta(manifests, findings, [], NO_LLM, protocol.hash, null);
    expect(meta.proposals.proposed).toBe(0);
    expect(meta.proposals.pct).toBeNull();
    const sentence = renderDocmendHeadline(protocol.checks.headline_template, meta, protocol.checks.no_proposals_text);
    expect(sentence).toBe('Not yet measured.');
  });
});
