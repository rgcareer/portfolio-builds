import { describe, it, expect } from 'vitest';
import { reverifyProposal } from '../src/reverify';
import { makeUnifiedDiff, makeInsertionDiffAtLine } from '../src/patch';
import { fakeLookup } from '../src/lookup';
import { loadProtocol } from '../src/protocol';
import type { Proposal } from '../src/types';
import { resolve } from 'node:path';

const protocol = loadProtocol(resolve(__dirname, '..', 'protocol'));

function baseProposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: 'p1',
    findingId: 'f1',
    pageId: 'page1',
    category: 'redirect-rewrite',
    source: 'mechanical',
    independence: 'measured',
    confidence: null,
    model: null,
    safe_to_auto_apply: true,
    reason: 'test',
    evidence: {},
    edit: { line: 1, old: 'a', new: 'b' },
    diff: null,
    target: { kind: 'repo-file', repo: 'repo-a', path: 'README.md', prReady: true },
    reverify: { status: 'skipped', methods: [], evidence: {}, checkedAt: null },
    ...overrides,
  };
}

describe('reverify: http-get-final (redirect-rewrite)', () => {
  it('passes when a fresh independent fetch confirms 200 with zero hops', async () => {
    const raw = 'See https://a.example/old for more.\n';
    const diff = makeUnifiedDiff(raw, 'https://a.example/old', 'https://a.example/new');
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    const proposal = baseProposal({ category: 'redirect-rewrite', diff: diff.diff, evidence: { url: 'https://a.example/old', finalUrl: 'https://a.example/new' } });
    const lookup = fakeLookup({ links: { 'https://a.example/new': { kind: 'chain', hops: [{ url: 'https://a.example/new', status: 200, location: null }], finalUrl: 'https://a.example/new', finalStatus: 200, error: null } } });
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks });
    expect(result.status).toBe('pass');
    expect(result.methods).toEqual(['http-get-final', 'patch-applies']);
  });

  it('fails when the fresh fetch no longer resolves to 200', async () => {
    const raw = 'See https://a.example/old for more.\n';
    const diff = makeUnifiedDiff(raw, 'https://a.example/old', 'https://a.example/new');
    if (!diff.ok) throw new Error('setup');
    const proposal = baseProposal({ category: 'redirect-rewrite', diff: diff.diff, evidence: { url: 'https://a.example/old', finalUrl: 'https://a.example/new' } });
    const lookup = fakeLookup({ links: { 'https://a.example/new': { kind: 'chain', hops: [{ url: 'https://a.example/new', status: 404, location: null }], finalUrl: 'https://a.example/new', finalStatus: 404, error: null } } });
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks });
    expect(result.status).toBe('fail');
  });
});

describe('reverify: registry-version-exists (pin-bump)', () => {
  it('passes when a fresh registry lookup confirms the proposed version exists and is not deprecated', async () => {
    const raw = 'npm install acme@1.2.0\n';
    const diff = makeUnifiedDiff(raw, 'acme@1.2.0', 'acme@1.9.0');
    if (!diff.ok) throw new Error('setup');
    const proposal = baseProposal({ category: 'pin-bump', diff: diff.diff, evidence: { ecosystem: 'npm', name: 'acme', pin: '1.2.0', latest: '1.9.0' } });
    const lookup = fakeLookup({ npm: { acme: { kind: 'registry', exists: true, latest: '1.9.0', deprecated: false, versions: ['1.2.0', '1.9.0'], deprecatedVersions: [] } } });
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks });
    expect(result.status).toBe('pass');
  });

  it('fails when the proposed version is now marked deprecated', async () => {
    const raw = 'npm install acme@1.2.0\n';
    const diff = makeUnifiedDiff(raw, 'acme@1.2.0', 'acme@1.9.0');
    if (!diff.ok) throw new Error('setup');
    const proposal = baseProposal({ category: 'pin-bump', diff: diff.diff, evidence: { ecosystem: 'npm', name: 'acme', pin: '1.2.0', latest: '1.9.0' } });
    const lookup = fakeLookup({ npm: { acme: { kind: 'registry', exists: true, latest: '2.0.0', deprecated: false, versions: ['1.2.0', '1.9.0', '2.0.0'], deprecatedVersions: ['1.9.0'] } } });
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks });
    expect(result.status).toBe('fail');
  });
});

describe('reverify: tree-path-exists (path-rewrite)', () => {
  it('passes when the rewritten path exists in the current tree listing', async () => {
    const raw = 'See [x](docs/missing.md).\n';
    const diff = makeUnifiedDiff(raw, 'docs/missing.md', 'guides/missing.md');
    if (!diff.ok) throw new Error('setup');
    const proposal = baseProposal({ category: 'path-rewrite', diff: diff.diff, evidence: { rewrittenTo: 'guides/missing.md' } });
    const lookup = fakeLookup({});
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks, tree: ['README.md', 'guides/missing.md'] });
    expect(result.status).toBe('pass');
  });

  it('fails when the rewritten path no longer exists in the tree', async () => {
    const raw = 'See [x](docs/missing.md).\n';
    const diff = makeUnifiedDiff(raw, 'docs/missing.md', 'guides/missing.md');
    if (!diff.ok) throw new Error('setup');
    const proposal = baseProposal({ category: 'path-rewrite', diff: diff.diff, evidence: { rewrittenTo: 'guides/missing.md' } });
    const lookup = fakeLookup({});
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks, tree: ['README.md'] });
    expect(result.status).toBe('fail');
  });
});

describe('reverify: recheck-patched-text (prose-prerequisite)', () => {
  it('passes when the patched text mentions the prerequisite and no new counted finding appears', async () => {
    const raw = 'intro\n\n```bash\necho $API_TOKEN\n```\n\noutro\n';
    const diff = makeInsertionDiffAtLine(raw, 5, 'Set the API_TOKEN environment variable first.');
    if (!diff.ok) throw new Error('setup');
    const proposal = baseProposal({ category: 'prose-prerequisite', diff: diff.diff, evidence: { kind: 'env', name: 'API_TOKEN' } });
    const lookup = fakeLookup({});
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks });
    expect(result.status).toBe('pass');
  });

  it('fails when the patch does not actually mention the prerequisite (check still fires)', async () => {
    const raw = 'intro\n\n```bash\necho $API_TOKEN\n```\n\noutro\n';
    const diff = makeInsertionDiffAtLine(raw, 5, 'This sentence forgot to mention the thing.');
    if (!diff.ok) throw new Error('setup');
    const proposal = baseProposal({ category: 'prose-prerequisite', diff: diff.diff, evidence: { kind: 'env', name: 'API_TOKEN' } });
    const lookup = fakeLookup({});
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks });
    expect(result.status).toBe('fail');
  });
});

describe('reverify: patch-applies (every category) and the git-apply-check hook', () => {
  it('fails when the underlying content has drifted since the diff was made (stale)', async () => {
    const raw = 'See https://a.example/old for more.\n';
    const diff = makeUnifiedDiff(raw, 'https://a.example/old', 'https://a.example/new');
    if (!diff.ok) throw new Error('setup');
    const drifted = 'The page changed entirely.\n';
    const proposal = baseProposal({ category: 'redirect-rewrite', diff: diff.diff, evidence: { url: 'https://a.example/old', finalUrl: 'https://a.example/new' } });
    const lookup = fakeLookup({ links: { 'https://a.example/new': { kind: 'chain', hops: [{ url: 'https://a.example/new', status: 200, location: null }], finalUrl: 'https://a.example/new', finalStatus: 200, error: null } } });
    const result = await reverifyProposal(proposal, { lookup, rawContent: drifted, checks: protocol.checks });
    expect(result.status).toBe('fail');
  });

  it('for a repo-file target, consults the injected git-apply-check hook and fails when it reports false', async () => {
    const raw = 'npm install acme@1.2.0\n';
    const diff = makeUnifiedDiff(raw, 'acme@1.2.0', 'acme@1.9.0');
    if (!diff.ok) throw new Error('setup');
    const proposal = baseProposal({ category: 'pin-bump', diff: diff.diff, evidence: { ecosystem: 'npm', name: 'acme', pin: '1.2.0', latest: '1.9.0' }, target: { kind: 'repo-file', repo: 'repo-a', path: 'README.md', prReady: true } });
    const lookup = fakeLookup({ npm: { acme: { kind: 'registry', exists: true, latest: '1.9.0', deprecated: false, versions: ['1.2.0', '1.9.0'], deprecatedVersions: [] } } });
    let called = false;
    const gitApplyCheck = () => {
      called = true;
      return { pass: false, detail: 'simulated git apply --check failure' };
    };
    const result = await reverifyProposal(proposal, { lookup, rawContent: raw, checks: protocol.checks, gitApplyCheck });
    expect(called).toBe(true);
    expect(result.status).toBe('fail');
  });

  it('a proposal with no diff always fails patch-applies', async () => {
    const proposal = baseProposal({ category: 'redirect-rewrite', diff: null, evidence: { url: 'https://a.example/old', finalUrl: 'https://a.example/new' } });
    const lookup = fakeLookup({ links: { 'https://a.example/new': { kind: 'chain', hops: [{ url: 'https://a.example/new', status: 200, location: null }], finalUrl: 'https://a.example/new', finalStatus: 200, error: null } } });
    const result = await reverifyProposal(proposal, { lookup, rawContent: 'anything\n', checks: protocol.checks });
    expect(result.status).toBe('fail');
  });
});
