import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runChecks, type PageCheckInput, type OwnRepoCheckContext } from '../src/checks';
import { fakeLookup, type ChainResult, type RegistryInfo } from '../src/lookup';
import { loadProtocol } from '../src/protocol';

const protocol = loadProtocol(resolve(__dirname, '..', 'protocol'));
const { checks, corpusRule } = protocol;
const linkRule = corpusRule.link;

function input(text: string, overrides: Partial<PageCheckInput> = {}): PageCheckInput {
  return { pageId: 'p0000000001', text, links: [], path: null, selfUrl: null, ...overrides };
}

function chain(finalStatus: number, hops?: Array<{ status: number; location?: string | null }>): ChainResult {
  const h = hops ?? [{ status: finalStatus, location: null }];
  return {
    kind: 'chain',
    hops: h.map((x, i) => ({ url: `https://example.com/${i}`, status: x.status, location: x.location ?? null })),
    finalUrl: 'https://example.com/final',
    finalStatus,
    error: null,
  };
}

describe('D-link / D-redirect', () => {
  it('a 200 link produces no finding', async () => {
    const text = 'See https://example.com/ok for details.\n';
    const lookup = fakeLookup({ links: { 'https://example.com/ok': chain(200) } });
    const r = await runChecks(input(text, { links: ['https://example.com/ok'] }), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(0);
  });

  it('a 404 link is a counted broken-link finding', async () => {
    const text = 'See https://example.com/dead for details.\n';
    const bad: ChainResult = { kind: 'chain', hops: [{ url: 'https://example.com/dead', status: 404, location: null }], finalUrl: 'https://example.com/dead', finalStatus: 404, error: null };
    const lookup = fakeLookup({ links: { 'https://example.com/dead': bad } });
    const r = await runChecks(input(text, { links: ['https://example.com/dead'] }), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('broken-link');
    expect(r.findings[0]!.counted).toBe(true);
  });

  it('a 403 link is treated as broken (never distinguished from a genuinely dead link)', async () => {
    const text = 'See https://example.com/wall.\n';
    const bad: ChainResult = { kind: 'chain', hops: [{ url: 'https://example.com/wall', status: 403, location: null }], finalUrl: 'https://example.com/wall', finalStatus: 403, error: null };
    const lookup = fakeLookup({ links: { 'https://example.com/wall': bad } });
    const r = await runChecks(input(text, { links: ['https://example.com/wall'] }), checks, linkRule, false, lookup, null);
    expect(r.findings[0]!.category).toBe('broken-link');
  });

  it('a permanent (301) redirect chain is a counted redirected-link finding', async () => {
    const text = 'See https://example.com/old.\n';
    const c = chain(200, [{ status: 301 }, { status: 200 }]);
    const lookup = fakeLookup({ links: { 'https://example.com/old': c } });
    const r = await runChecks(input(text, { links: ['https://example.com/old'] }), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('redirected-link');
    expect(r.findings[0]!.counted).toBe(true);
  });

  it('a temporary (302) redirect is informational (recorded, not counted)', async () => {
    const text = 'See https://example.com/temp.\n';
    const c = chain(200, [{ status: 302 }, { status: 200 }]);
    const lookup = fakeLookup({ links: { 'https://example.com/temp': c } });
    const r = await runChecks(input(text, { links: ['https://example.com/temp'] }), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('redirected-link');
    expect(r.findings[0]!.counted).toBe(false);
  });

  it('external pages cap link checks at external_max_links (25); own pages check all', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://example.com/p${i}`);
    const text = many.join(' ') + '\n';
    const lookup = fakeLookup({});
    const rExt = await runChecks(input(text, { links: many }), checks, linkRule, true, lookup, null);
    expect(rExt.stats.linksChecked).toBe(25);
    const rOwn = await runChecks(input(text, { links: many }), checks, linkRule, false, lookup, null);
    expect(rOwn.stats.linksChecked).toBe(30);
  });

  it('excludes image/badge links and the page itself', async () => {
    const links = ['https://shields.io/badge/x', 'https://example.com/logo.png', 'https://example.com/self', 'https://example.com/real'];
    const lookup = fakeLookup({});
    const r = await runChecks(input('x', { links, selfUrl: 'https://example.com/self' }), checks, linkRule, false, lookup, null);
    expect(r.stats.linksChecked).toBe(1);
  });
});

describe('D-pkg-exists / D-pin (pin policy)', () => {
  it('a package that does not exist in its registry is a counted finding', async () => {
    const text = 'Install with npm.\n\n```bash\nnpm install totally-not-real\n```\n';
    const lookup = fakeLookup({ npm: { 'totally-not-real': { kind: 'registry', exists: false, latest: null, deprecated: false, versions: [], deprecatedVersions: [] } } });
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.checkId).toBe('D-pkg-exists');
  });

  it('a same-major pin behind latest is stale-pin (safe territory)', async () => {
    const text = 'Install with npm.\n\n```bash\nnpm install acme@1.2.0\n```\n';
    const lookup = fakeLookup({ npm: { acme: { kind: 'registry', exists: true, latest: '1.9.0', deprecated: false, versions: ['1.2.0', '1.9.0'], deprecatedVersions: [] } } });
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('stale-pin');
  });

  it('a major-behind pin is version-drift', async () => {
    const text = 'Install with npm.\n\n```bash\nnpm install acme@1.0.0\n```\n';
    const lookup = fakeLookup({ npm: { acme: { kind: 'registry', exists: true, latest: '3.0.0', deprecated: false, versions: ['1.0.0', '3.0.0'], deprecatedVersions: [] } } });
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('version-drift');
    expect(r.findings[0]!.detail).toContain('2 major behind');
  });

  it('a deprecated registry latest is flagged even when the pin itself is current', async () => {
    const text = '```bash\nnpm install acme@2.0.0\n```\n';
    const lookup = fakeLookup({ npm: { acme: { kind: 'registry', exists: true, latest: '2.0.0', deprecated: true, versions: ['2.0.0'], deprecatedVersions: ['2.0.0'] } } });
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings.some((f) => f.detail.includes('deprecated'))).toBe(true);
  });

  it('PEP 503: pypi package names normalize before lookup (dots/underscores/case fold to hyphen-lower)', async () => {
    const text = 'Install with pip.\n\n```bash\npip install My_Package.Name==1.0.0\n```\n';
    const calls: string[] = [];
    const lookup = fakeLookup({ pypi: { 'my-package-name': { kind: 'registry', exists: true, latest: '1.0.0', deprecated: false, versions: ['1.0.0'], deprecatedVersions: [] } } });
    const orig = lookup.pypi.bind(lookup);
    lookup.pypi = async (name: string) => {
      calls.push(name);
      return orig(name);
    };
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(calls).toEqual(['My_Package.Name']);
    expect(r.stats.pins).toBe(1);
    expect(r.findings).toHaveLength(0); // pin === latest, no drift
  });
});

describe('D-code-parse: JSON and bash -n parsing with prompt stripping', () => {
  it('a valid JSON fence produces no finding', async () => {
    const text = '```json\n{"a": 1}\n```\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(0);
    expect(r.stats.snippets).toBe(1);
  });

  it('an invalid JSON fence is a counted finding', async () => {
    const text = '```json\n{"a": 1,}\n```\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.checkId).toBe('D-code-parse');
  });

  it('a bash fence with a shell-prompt prefix parses after prompt stripping', async () => {
    const text = '```bash\n$ echo "hello world"\n```\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(0);
  });

  it('a bash fence with unbalanced quoting is a counted finding', async () => {
    const text = '```bash\necho "unterminated\n```\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.checkId).toBe('D-code-parse');
  });

  it('console and text fences are ignored (never checked)', async () => {
    const text = '```console\nthis is not real { code (\n```\n```text\nnor is this )))\n```\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(0);
    expect(r.stats.snippets).toBe(0);
  });

  it('a fence with an ellipsis marker is skipped as an intentional fragment', async () => {
    const text = '```json\n{ "a": 1, ...\n```\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings).toHaveLength(0);
  });
});

describe('D-rel-path (own repos only): exists / unique / ambiguous / none', () => {
  const ctxBase: OwnRepoCheckContext = { tree: ['README.md', 'docs/one.md', 'docs/nested/two.md', 'guides/two.md'], packageJson: null };

  it('a relative link that exists produces no finding', async () => {
    const text = 'See [one](docs/one.md) for setup.\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: 'README.md' }), checks, linkRule, false, lookup, ctxBase);
    expect(r.findings).toHaveLength(0);
  });

  it('a relative link with exactly one same-basename candidate elsewhere in the tree is a finding with one candidate', async () => {
    const text = 'See [missing](docs/three.md) for setup.\n';
    const ctx: OwnRepoCheckContext = { tree: ['README.md', 'guides/three.md'], packageJson: null };
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: 'README.md' }), checks, linkRule, false, lookup, ctx);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('broken-relative-path');
    expect((r.findings[0]!.evidence['candidates'] as string[]).sort()).toEqual(['guides/three.md']);
  });

  it('an ambiguous basename (two tree files share it) lists both candidates', async () => {
    const text = 'See [two](docs/does-not-exist/two.md) for setup.\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: 'README.md' }), checks, linkRule, false, lookup, ctxBase);
    expect(r.findings).toHaveLength(1);
    expect((r.findings[0]!.evidence['candidates'] as string[]).sort()).toEqual(['docs/nested/two.md', 'guides/two.md']);
  });

  it('a relative link with no matching basename anywhere has zero candidates', async () => {
    const text = 'See [ghost](nowhere/ghost.md) for setup.\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: 'README.md' }), checks, linkRule, false, lookup, ctxBase);
    expect(r.findings).toHaveLength(1);
    expect((r.findings[0]!.evidence['candidates'] as string[])).toEqual([]);
  });

  it('D-rel-path never fires on site/external pages (no ownRepoCtx)', async () => {
    const text = 'See [x](docs/does-not-exist.md).\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: null }), checks, linkRule, false, lookup, null);
    expect(r.findings.filter((f) => f.checkId === 'D-rel-path')).toHaveLength(0);
  });
});

describe('D-script and D-engine drift (own repos only)', () => {
  it('D-script fires when the documented npm script does not exist in package.json', async () => {
    const text = 'Run `npm run buildzzz` to build.\n';
    const ctx: OwnRepoCheckContext = { tree: [], packageJson: { scripts: { build: 'tsc' } } };
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: 'README.md' }), checks, linkRule, false, lookup, ctx);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('broken-script');
  });

  it('D-script does not fire when the script exists', async () => {
    const text = 'Run `npm run build` to build.\n';
    const ctx: OwnRepoCheckContext = { tree: [], packageJson: { scripts: { build: 'tsc' } } };
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: 'README.md' }), checks, linkRule, false, lookup, ctx);
    expect(r.findings).toHaveLength(0);
  });

  it('D-engine fires when the README Node claim does not match engines.node', async () => {
    const text = 'Requires Node.js 18 or later.\n';
    const ctx: OwnRepoCheckContext = { tree: [], packageJson: { engines: { node: '>=22.12.0' } } };
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: 'README.md' }), checks, linkRule, false, lookup, ctx);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe('engine-mismatch');
  });

  it('D-engine does not fire when the README claim matches engines.node', async () => {
    const text = 'Requires Node.js 22 or later.\n';
    const ctx: OwnRepoCheckContext = { tree: [], packageJson: { engines: { node: '>=22.12.0' } } };
    const lookup = fakeLookup({});
    const r = await runChecks(input(text, { path: 'README.md' }), checks, linkRule, false, lookup, ctx);
    expect(r.findings).toHaveLength(0);
  });
});

describe('D-placeholder', () => {
  it('flags an unresolved placeholder marker in prose', async () => {
    const text = 'Pricing: TBD. More details coming soon.\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings.filter((f) => f.checkId === 'D-placeholder').length).toBeGreaterThanOrEqual(1);
  });

  it('does not fire on clean prose', async () => {
    const text = 'Pricing is $10 per month, billed annually.\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings.filter((f) => f.checkId === 'D-placeholder')).toHaveLength(0);
  });
});

describe('D-prereq (copied from OTR verbatim)', () => {
  it('flags an env var used in code but never mentioned in prose', async () => {
    const text = 'Set it up and run the server.\n\n```bash\necho $API_TOKEN\n```\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings.some((f) => f.checkId === 'D-prereq' && f.category === 'missing-prerequisite')).toBe(true);
  });

  it('does not fire when the env var is mentioned in prose', async () => {
    const text = 'Set the API_TOKEN environment variable first.\n\n```bash\necho $API_TOKEN\n```\n';
    const lookup = fakeLookup({});
    const r = await runChecks(input(text), checks, linkRule, false, lookup, null);
    expect(r.findings.filter((f) => f.checkId === 'D-prereq')).toHaveLength(0);
  });
});

describe('checks.json is real and loadable', () => {
  it('protocol/checks.json matches the on-disk file', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '..', 'protocol', 'checks.json'), 'utf8'));
    expect(raw.checks.map((c: { id: string }) => c.id)).toEqual(checks.checks.map((c) => c.id));
  });
});
