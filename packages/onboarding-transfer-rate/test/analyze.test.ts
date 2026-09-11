import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stableStringify, sha256Hex, renderHeadline } from '@portfolio-builds/shared';
import { loadProtocol } from '../src/protocol';
import { analyzeCorpus } from '../src/analyze';
import { fakeLookup } from '../src/registries';
import type { Manifest } from '../src/snapshot';

const protocol = loadProtocol();
let corpus: string;

function page(id: string, repo: string, probe: string, text: string, links: string[] = []): void {
  const dir = resolve(corpus, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'text.txt'), text);
  writeFileSync(resolve(dir, 'raw.md'), text);
  const m: Manifest = {
    id,
    repo,
    stars: 1,
    probe,
    url: `https://example.com/${id}`,
    finalUrl: `https://example.com/${id}`,
    hops: 0,
    status: 200,
    fetchedAt: '2026-09-11T06:00:00.000Z',
    kind: 'markdown',
    rawFile: 'raw.md',
    bytes: text.length,
    sha256Raw: sha256Hex(text),
    sha256Text: sha256Hex(text),
    title: null,
    links,
  };
  writeFileSync(resolve(dir, 'manifest.json'), stableStringify(m));
}

beforeAll(() => {
  corpus = mkdtempSync(resolve(tmpdir(), 'otr-analyze-'));
  // A: milestone + clean L1 (tool and env var mentioned in prose; package exists; link ok)
  page('q_a', 'a/a', 'P3-readme-section', '## Quick Start\n\nInstall with pip and set MY_KEY:\n\n```bash\npip install acme\nexport MY_KEY=x\n```\n\nYou should see:\n\n```\nok\n```\n', ['https://a.example/docs']);
  // B: milestone but L1 fails (docker never mentioned in prose)
  page('q_b', 'b/b', 'P1-homepage-link', '# B\n\n```bash\ndocker run b\n```\n\nCongratulations, you did it.\n');
  // C: no milestone; also a broken link
  page('q_c', 'c/c', 'P3-readme-section', '## Getting started\n\nSee https://c.example/gone for details.\n\n```bash\nnpm i c-pkg\n```\n', ['https://c.example/gone']);
});
afterAll(() => rmSync(corpus, { recursive: true, force: true }));

describe('analyzeCorpus', () => {
  it('computes k0/k1, Wilson strings, category and probe tallies from the corpus only', async () => {
    const lookup = fakeLookup({
      pypi: { acme: { exists: true, latest: '1.0.0', deprecated: false } },
      npm: { 'c-pkg': { exists: true, latest: '2.0.0', deprecated: false } },
      links: { 'https://c.example/gone': { status: 404, ok: false, error: null } },
    });
    const { pages, runMeta } = await analyzeCorpus(protocol, corpus, lookup, {
      protocolCommit: 'abc',
      seededAt: '2026-09-11T05:49:30.812Z',
      exclusions: [{ full_name: 'x/y', reason: 'render-blocked', stage: 'snapshot', at: 't' }],
      targetN: 50,
      lookupCacheEntries: () => 3,
    });
    expect(pages.map((p) => [p.id, !!p.milestone, p.l1Passed])).toEqual([
      ['q_a', true, true],
      ['q_b', true, false],
      ['q_c', false, false],
    ]);
    expect(runMeta.n).toBe(3);
    expect(runMeta.k0).toBe(2);
    expect(runMeta.n0).toBe(2);
    expect(runMeta.k1).toBe(1);
    expect(runMeta.pct).toEqual({ p0: '66.7', lo0: '20.8', hi0: '93.9', p1: '50.0', lo1: '9.5', hi1: '90.5' });
    // B: docker never in prose; C: npm never in prose
    expect(runMeta.categories['missing-prerequisite']).toEqual({ pages: 2, findings: 2 });
    expect(runMeta.categories['broken-link']).toEqual({ pages: 1, findings: 1 });
    expect(runMeta.categories['undefined-success']).toEqual({ pages: 1, findings: 1 });
    expect(runMeta.categories['no-time-claim']).toEqual({ pages: 3, findings: 3 });
    expect(runMeta.probes).toEqual({ 'P1-homepage-link': 1, 'P3-readme-section': 2 });
    expect(runMeta.exclusions).toEqual({ 'render-blocked': 1 });
    expect(runMeta.snapshotDate).toBe('2026-09-11');
    expect(runMeta.llmCostUsd).toBe(0);
    expect(runMeta.protocolHash).toBe(protocol.hash);
  });

  it('the headline template renders from run-meta and nothing else', async () => {
    const lookup = fakeLookup({ pypi: { acme: { exists: true, latest: '1.0.0', deprecated: false } }, npm: { 'c-pkg': { exists: true, latest: '2.0.0', deprecated: false } } });
    const { runMeta } = await analyzeCorpus(protocol, corpus, lookup, { protocolCommit: null, seededAt: null, exclusions: [], targetN: 50, lookupCacheEntries: () => 0 });
    const s = renderHeadline(protocol.checks.headline_template, { n: runMeta.n, date: runMeta.snapshotDate, k0: runMeta.k0, n0: runMeta.n0, k1: runMeta.k1, ...runMeta.pct! });
    expect(s).toBe(
      'Of 3 official AI-tool quickstarts snapshotted 2026-09-11, 2 (66.7%, 95% Wilson CI 20.8-93.9%) state a verifiable first-success milestone; 1 of those 2 pass every pre-registered integrity check (50.0%, CI 9.5-90.5%).',
    );
  });

  it('is deterministic across two runs on the same corpus and cache (modulo generatedAt)', async () => {
    const mk = () => fakeLookup({ pypi: { acme: { exists: true, latest: '1.0.0', deprecated: false } }, npm: { 'c-pkg': { exists: true, latest: '2.0.0', deprecated: false } } });
    const a = await analyzeCorpus(protocol, corpus, mk(), { protocolCommit: null, seededAt: null, exclusions: [], targetN: 50, lookupCacheEntries: () => 0 });
    const b = await analyzeCorpus(protocol, corpus, mk(), { protocolCommit: null, seededAt: null, exclusions: [], targetN: 50, lookupCacheEntries: () => 0 });
    expect(stableStringify(a.pages)).toBe(stableStringify(b.pages));
    const strip = (m: object) => stableStringify({ ...m, generatedAt: null });
    expect(strip(a.runMeta)).toBe(strip(b.runMeta));
  });
});
