import { describe, it, expect } from 'vitest';
import { renderReportMarkdown, renderReportJson } from '../src/report';
import { computeRunMeta, type LlmStats } from '../src/analyze';
import { loadProtocol } from '../src/protocol';
import type { Manifest } from '../src/snapshot';
import type { PageFindings, Proposal, Finding } from '../src/types';
import { resolve } from 'node:path';

const protocol = loadProtocol(resolve(__dirname, '..', 'protocol'));
const NO_LLM: LlmStats = { calls: 2, errors: 1, costUsd: 0, mock: 2 };

const manifests: Manifest[] = [{ pageId: 'p1', source: 'own-repo', sourceId: 'repo-a', repo: 'repo-a', path: 'README.md', url: null, kind: 'markdown', rawFile: 'raw.md', bytes: 1, sha256Raw: 'x', sha256Text: 'y', title: null, links: [], fetchedAt: '2026-01-01T00:00:00Z' }];

function finding(overrides: Partial<Finding>): Finding {
  return { id: 'f1', pageId: 'p1', checkId: 'D-link', category: 'broken-link', line: 1, excerpt: 'x', detail: 'x', counted: true, evidence: {}, ...overrides };
}

const pageFindings: PageFindings[] = [{ pageId: 'p1', source: 'own-repo', repo: 'repo-a', path: 'README.md', findings: [finding({}), finding({ id: 'f2', category: 'placeholder-text' })], stats: { installs: 0, pins: 0, snippets: 0, linksChecked: 1 } }];

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
    reason: 'safe rewrite',
    evidence: {},
    edit: { line: 1, old: 'a', new: 'b' },
    diff: '--- a\n+++ a\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    target: { kind: 'repo-file', repo: 'repo-a', path: 'README.md', prReady: true },
    reverify: { status: 'pass', methods: ['patch-applies'], evidence: {}, checkedAt: '2026-01-01T00:00:00Z' },
    ...overrides,
  };
}

describe('renderReportMarkdown', () => {
  it('includes the headline, corpus stats, drift-by-category, and proposal lines', () => {
    const meta = computeRunMeta(manifests, pageFindings, [proposal({})], NO_LLM, protocol.hash, 'abc');
    const md = renderReportMarkdown(meta, pageFindings, [proposal({})], protocol.checks);
    expect(md).toContain('# docmend report');
    expect(md).toContain('broken-link: 1');
    expect(md).toContain('placeholder-text: 1');
    expect(md).toContain('`pr1`');
    expect(md).toContain('reverify=pass');
    expect(md).toContain('## Not measured');
  });

  it('says "none proposed yet" when there are zero proposals', () => {
    const meta = computeRunMeta(manifests, pageFindings, [], NO_LLM, protocol.hash, 'abc');
    const md = renderReportMarkdown(meta, pageFindings, [], protocol.checks);
    expect(md).toContain('none proposed yet');
    expect(md).toContain('Not yet measured.');
  });
});

describe('renderReportJson', () => {
  it('round-trips through JSON.parse with the same page/proposal counts', () => {
    const proposals = [proposal({})];
    const meta = computeRunMeta(manifests, pageFindings, proposals, NO_LLM, protocol.hash, 'abc');
    const json = renderReportJson(meta, pageFindings, proposals);
    const parsed = JSON.parse(json);
    expect(parsed.pageFindings).toHaveLength(1);
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.runMeta.corpus.pages).toBe(1);
  });
});
