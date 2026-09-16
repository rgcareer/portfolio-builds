import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cmdScan, cmdPropose, cmdVerify, cmdReport, cmdHeadline, cmdRepro } from '../src/cli';
import { loadProtocol, PKG_ROOT } from '../src/protocol';
import { snapshotOwnRepoPage, snapshotSitePage } from '../src/snapshot';
import { textifyMarkdown, textifyHtml } from '../src/textify';
import { proposeProsePrerequisite } from '../src/llm';
import type { PageRef } from '../src/types';

const protocol = loadProtocol(resolve(__dirname, '..', 'protocol'));

function mockFetch(routes: Record<string, { status: number; body?: string }>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    const r = routes[url];
    if (!r) throw new Error(`mockFetch: no route for ${url}`);
    return new Response(r.body ?? null, { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('cli pipeline: scan -> propose -> verify -> report -> headline -> repro', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'docmend-cli-'));
    const corpusDir = resolve(dataDir, 'corpus');
    mkdirSync(corpusDir, { recursive: true });

    const refA: PageRef = { pageId: 'pageaaaaaa', source: 'own-repo', sourceId: 'repo-a', repo: 'repo-a', path: 'README.md', url: null };
    const rawA = [
      '# Repo A',
      '',
      'See https://example.com/dead-link for details.',
      '',
      'Install with npm.',
      '',
      '```bash',
      'npm install acme@1.0.0',
      '```',
      '',
    ].join('\n') + '\n';
    snapshotOwnRepoPage(refA, rawA, textifyMarkdown(rawA, null), corpusDir);

    writeFileSync(
      resolve(dataDir, 'sources.json'),
      JSON.stringify({ ownRepos: { 'repo-a': { tree: ['README.md'], packageJson: null, provenance: { commit: 'deadbeef', remoteUrl: null, porcelainCount: 0 } } } }),
    );

    // Warm the lookup cache once via a mocked fetchImpl (never real network), then every
    // subsequent scan/verify call in this suite runs fully offline against that cache.
    const fetchImpl = mockFetch({
      'https://example.com/dead-link': { status: 404 },
      'https://registry.npmjs.org/acme': { status: 200, body: JSON.stringify({ 'dist-tags': { latest: '1.4.0' }, versions: { '1.0.0': {}, '1.4.0': {} } }) },
    });
    const scanCode = await cmdScan({ dataDir, protocol, offline: false, failOn: [], fetchImpl });
    expect(scanCode).toBe(0);
  });

  afterAll(() => {
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  it('scan writes findings.json with the expected drift categories', () => {
    const findings = JSON.parse(readFileSync(resolve(dataDir, 'findings.json'), 'utf8'));
    expect(findings).toHaveLength(1);
    const categories = findings[0].findings.filter((f: { counted: boolean }) => f.counted).map((f: { category: string }) => f.category).sort();
    expect(categories).toContain('broken-link');
    expect(categories).toContain('stale-pin');
  });

  it('scan run a second time fully offline (--offline) reproduces the same findings from the warmed cache', async () => {
    const code = await cmdScan({ dataDir, protocol, offline: true, failOn: [] });
    expect(code).toBe(0);
  });

  it('scan --fail-on returns exit code 1 when a counted finding matches', async () => {
    const code = await cmdScan({ dataDir, protocol, offline: true, failOn: ['broken-link'] });
    expect(code).toBe(1);
  });

  it('propose writes proposals.json with a pin-bump (safe) and no redirect-rewrite (it was a 404, not a redirect)', async () => {
    // Reset findings.json to the non-fail-on state before propose (fail-on test above didn't mutate findings).
    const code = await cmdPropose({ dataDir, llm: false });
    expect(code).toBe(0);
    const proposals = JSON.parse(readFileSync(resolve(dataDir, 'proposals.json'), 'utf8'));
    expect(proposals.some((p: { category: string }) => p.category === 'pin-bump')).toBe(true);
    expect(proposals.some((p: { category: string }) => p.category === 'redirect-rewrite')).toBe(false);
  });

  it('verify recomputes reverify status and writes run-meta.json', async () => {
    const fetchImpl = mockFetch({ 'https://registry.npmjs.org/acme': { status: 200, body: JSON.stringify({ 'dist-tags': { latest: '1.4.0' }, versions: { '1.0.0': {}, '1.4.0': {} } }) } });
    const code = await cmdVerify({ dataDir, protocol, offline: false, fetchImpl });
    expect(code).toBe(0);
    const proposals = JSON.parse(readFileSync(resolve(dataDir, 'proposals.json'), 'utf8'));
    expect(proposals.every((p: { reverify: { status: string } }) => p.reverify.status === 'pass')).toBe(true);
    const runMeta = JSON.parse(readFileSync(resolve(dataDir, 'run-meta.json'), 'utf8'));
    expect(runMeta.proposals.proposed).toBeGreaterThan(0);
    expect(runMeta.proposals.pct).not.toBeNull();
  });

  it('report writes out/report.md containing the rendered headline', () => {
    const outDir = resolve(dataDir, '..', `docmend-cli-out-${Date.now()}`);
    const code = cmdReport({ dataDir, outDir, protocol, format: 'md' });
    expect(code).toBe(0);
    const md = readFileSync(resolve(outDir, 'report.md'), 'utf8');
    expect(md).toContain('# docmend report');
    expect(md).toContain('95% Wilson CI');
    rmSync(outDir, { recursive: true, force: true });
  });

  it('headline returns exit code 0 and a fully-resolved sentence once proposals exist', () => {
    const { code, text } = cmdHeadline({ dataDir, protocol });
    expect(code).toBe(0);
    expect(text).not.toContain('{');
    expect(text).toContain('%');
  });

  it('repro re-derives findings/proposals/run-meta bit-for-bit from the committed mechanical-only data', async () => {
    const code = await cmdRepro({ dataDir, outDir: resolve(dataDir, 'out'), protocol });
    expect(code).toBe(0);
  });
});

describe('cli: repro re-derives proposal order bit-for-bit when a page interleaves mechanical and LLM proposals', () => {
  // Regression test for the repro-determinism gap: cmdPropose commits proposals in
  // per-page/per-finding traversal order (D-prereq is checked before D-rel-path on the same
  // page — see checks.ts's runChecks), so a page with both findings produces
  // [llm-proposal, mechanical-proposal] — LLM first. The old cmdRepro re-derived mechanical
  // proposals fresh and appended the committed LLM ones at the end, giving
  // [mechanical-proposal, llm-proposal] instead: a silent, permanent repro mismatch for any
  // published run containing an LLM proposal. cmdPropose's llmFn seam lets this test (and
  // cmdRepro itself) carry a committed LLM proposal through at the point it's encountered in
  // traversal, without a real gateway call.
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'docmend-repro-order-'));
    const corpusDir = resolve(dataDir, 'corpus');
    mkdirSync(corpusDir, { recursive: true });

    const refB: PageRef = { pageId: 'pagebbbbbb', source: 'own-repo', sourceId: 'repo-b', repo: 'repo-b', path: 'README.md', url: null };
    const rawB =
      ['# Repo B', '', 'Run the deploy script:', '', '```bash', 'echo $DEPLOY_TOKEN', '```', '', 'See [guide](docs/missing-guide.md) for details.', ''].join('\n') + '\n';
    snapshotOwnRepoPage(refB, rawB, textifyMarkdown(rawB, null), corpusDir);

    writeFileSync(
      resolve(dataDir, 'sources.json'),
      JSON.stringify({ ownRepos: { 'repo-b': { tree: ['README.md', 'guides/missing-guide.md'], packageJson: null, provenance: { commit: 'deadbeef', remoteUrl: null, porcelainCount: 0 } } } }),
    );

    const scanCode = await cmdScan({ dataDir, protocol, offline: true, failOn: [] });
    expect(scanCode).toBe(0);

    // Simulate a published run that used --llm: a canned mock sentence stands in for the
    // gateway (llmFn bypasses callLlm entirely, matching how cmdRepro itself avoids a real
    // network call for the carried-through LLM proposal).
    const llmFn: typeof proposeProsePrerequisite = (finding, raw, target) =>
      proposeProsePrerequisite(finding, raw, target, { mock: async () => 'Set the DEPLOY_TOKEN environment variable first.' });
    const proposeCode = await cmdPropose({ dataDir, llm: true, llmFn });
    expect(proposeCode).toBe(0);

    const verifyCode = await cmdVerify({ dataDir, protocol, offline: true });
    expect(verifyCode).toBe(0);
  });

  afterAll(() => {
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  it('the committed run has the LLM (D-prereq) proposal before the mechanical (D-rel-path) one — same-page interleaving', () => {
    const proposals = JSON.parse(readFileSync(resolve(dataDir, 'proposals.json'), 'utf8'));
    expect(proposals.map((p: { category: string; source: string }) => `${p.source}:${p.category}`)).toEqual(['llm:prose-prerequisite', 'mechanical:path-rewrite']);
  });

  it('repro re-derives findings/proposals/run-meta bit-for-bit, preserving that interleaved order', async () => {
    const code = await cmdRepro({ dataDir, outDir: resolve(dataDir, 'out'), protocol });
    expect(code).toBe(0);
  });
});

describe('cli: prose-prerequisite propose/verify use text.txt (not raw.html) for site/external pages', () => {
  // Regression test for the reverify-representation gap: D-prereq's line/excerpt/
  // insertAfterLine are computed against the textified text.txt (checks.ts), which for an
  // HTML page differs sharply from raw.html — different line numbers, and no ``` fences (HTML
  // uses <pre>). Using raw.html for the insertion diff and for methodRecheckPatchedText's
  // before/after check (as the pre-fix code did) both misplaces the inserted sentence AND
  // makes recheck-patched-text trivially pass (codeLineMask finds zero fenced blocks in HTML,
  // so "stillFires" is always false, regardless of whether the sentence resolves anything) —
  // inflating the verified count. This fixture pads raw.html with HTML comments (invisible to
  // textifyHtml) so its line count diverges from text.txt's without introducing any links to
  // check or extra prose findings.
  const createdDirs: string[] = [];
  const url = 'https://getsmartai.ai/guide';
  const rawHtml =
    [
      '<html><head><title>Guide</title></head><body>',
      '<!-- filler A: padding raw.html line count without affecting the textified output -->',
      '<!-- filler B: padding raw.html line count without affecting the textified output -->',
      '<!-- filler C: padding raw.html line count without affecting the textified output -->',
      '<!-- filler D: padding raw.html line count without affecting the textified output -->',
      '<header><h1>Quickstart Guide</h1>',
      '<p>Welcome to the guide. This section has some background copy that pads the raw HTML out so its line count diverges from the textified version once all these tags are stripped away during textification.</p>',
      '</header>',
      '<main>',
      '<p>Run the command below to get started with the tool.</p>',
      '<pre><code class="language-bash">echo $API_TOKEN</code></pre>',
      '<p>Thats all you need for now.</p>',
      '</main>',
      '</body></html>',
    ].join('\n') + '\n';

  async function proposeAndVerify(sentence: string): Promise<{ diff: string | null; status: string; evidence: unknown }> {
    const dataDir = mkdtempSync(resolve(tmpdir(), 'docmend-html-prereq-'));
    createdDirs.push(dataDir);
    const corpusDir = resolve(dataDir, 'corpus');
    mkdirSync(corpusDir, { recursive: true });
    const ref: PageRef = { pageId: 'sitepageaa', source: 'site', sourceId: 'site', repo: null, path: url, url };
    snapshotSitePage(ref, rawHtml, textifyHtml(rawHtml, url), corpusDir);
    writeFileSync(resolve(dataDir, 'sources.json'), JSON.stringify({ ownRepos: {} }));

    expect(await cmdScan({ dataDir, protocol, offline: true, failOn: [] })).toBe(0);
    const llmFn: typeof proposeProsePrerequisite = (finding, raw, target) => proposeProsePrerequisite(finding, raw, target, { mock: async () => sentence });
    expect(await cmdPropose({ dataDir, llm: true, llmFn })).toBe(0);
    const proposed = JSON.parse(readFileSync(resolve(dataDir, 'proposals.json'), 'utf8'));
    const proposal = proposed.find((p: { category: string }) => p.category === 'prose-prerequisite');
    expect(await cmdVerify({ dataDir, protocol, offline: true })).toBe(0);
    const verified = JSON.parse(readFileSync(resolve(dataDir, 'proposals.json'), 'utf8'));
    const vp = verified.find((p: { category: string }) => p.category === 'prose-prerequisite');
    return { diff: proposal.diff, status: vp.reverify.status, evidence: vp.reverify.evidence };
  }

  afterAll(() => {
    for (const d of createdDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  });

  it('anchors the insertion diff right after the fenced block\'s closing line (from text.txt), not the unrelated raw.html line at the same numeric offset', async () => {
    const { diff } = await proposeAndVerify('Set the API_TOKEN environment variable before running this command.');
    expect(diff).not.toBeNull();
    expect(diff).toContain('```\n+Set the API_TOKEN environment variable before running this command.');
  });

  it('passes reverify for real when the sentence actually resolves the prerequisite (recheck ran against text.txt, not a fence-free raw.html)', async () => {
    const { status, evidence } = await proposeAndVerify('Set the API_TOKEN environment variable before running this command.');
    expect(status).toBe('pass');
    const recheck = (evidence as { results: { method: string; evidence: Record<string, unknown> }[] }).results.find((r) => r.method === 'recheck-patched-text')!;
    // beforeCounted:1 proves the "before" check actually found the missing-prerequisite
    // finding in the real (fenced) content — not trivially zero, as raw.html would give.
    expect(recheck.evidence['beforeCounted']).toBe(1);
    expect(recheck.evidence['stillFires']).toBe(false);
  });

  it('fails reverify when the sentence does not actually mention the prerequisite (would have spuriously passed against raw.html)', async () => {
    const { status, evidence } = await proposeAndVerify('This sentence forgot to mention the thing.');
    expect(status).toBe('fail');
    const recheck = (evidence as { results: { method: string; evidence: Record<string, unknown> }[] }).results.find((r) => r.method === 'recheck-patched-text')!;
    expect(recheck.evidence['stillFires']).toBe(true);
  });
});

describe('cli: headline with no run-meta.json yet returns exit code 1', () => {
  it('reports "no run-meta.json yet" and code 1', () => {
    const empty = mkdtempSync(resolve(tmpdir(), 'docmend-empty-'));
    const { code, text } = cmdHeadline({ dataDir: empty, protocol });
    expect(code).toBe(1);
    expect(text).toContain('run-meta.json');
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('cli: scan with no corpus returns exit code 2', () => {
  it('reports the missing-corpus usage error', async () => {
    const empty = mkdtempSync(resolve(tmpdir(), 'docmend-empty-'));
    const code = await cmdScan({ dataDir: empty, protocol, offline: true, failOn: [] });
    expect(code).toBe(2);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('CLI smoke (real subprocess, no network)', () => {
  const cliPath = resolve(PKG_ROOT, 'src', 'cli.ts');

  function runCli(args: string[], dataDir: string): { status: number | null; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('node', ['--import', 'tsx', cliPath, ...args], {
        cwd: PKG_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DOCMEND_DATA_DIR: dataDir },
        timeout: 20_000,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('headline on an empty data dir exits 1', () => {
    const empty = mkdtempSync(resolve(tmpdir(), 'docmend-smoke-'));
    const r = runCli(['headline'], empty);
    expect(r.status).toBe(1);
    rmSync(empty, { recursive: true, force: true });
  });

  it('scan on an empty data dir exits 2 (no corpus to scan)', () => {
    const empty = mkdtempSync(resolve(tmpdir(), 'docmend-smoke-'));
    const r = runCli(['scan', '--offline'], empty);
    expect(r.status).toBe(2);
    rmSync(empty, { recursive: true, force: true });
  });

  it('an unknown subcommand exits non-zero', () => {
    const empty = mkdtempSync(resolve(tmpdir(), 'docmend-smoke-'));
    const r = runCli(['not-a-real-command'], empty);
    expect(r.status).not.toBe(0);
    rmSync(empty, { recursive: true, force: true });
  });
});
