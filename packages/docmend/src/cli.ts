#!/usr/bin/env node
// docmend CLI: scan -> propose -> verify -> report/headline, or the whole pipeline via
// `run --live`. Every exported cmd* function takes explicit paths (never reads env itself)
// so it is directly unit-testable; the citty wrapper at the bottom resolves real paths from
// the environment and is what `bin/docmend` actually runs.
//
// Exit codes: 0 ok · 1 findings matched --fail-on (scan) or a repro mismatch · 2 usage/config
// (missing prerequisite data file) · 3 runtime error (caught and reported).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { defineCommand, runMain } from 'citty';
import { Ledger, stableStringify, type GatewayOptions } from '@portfolio-builds/shared';
import { loadProtocol, DATA_DIR, OUT_DIR, PKG_ROOT, type Protocol } from './protocol';
import { readManifest, readManifests, readManifestText, corpusHas, snapshotOwnRepoPage, snapshotSitePage, snapshotExternalPage, type Manifest } from './snapshot';
import { discoverOwnRepoPages, discoverSitePages, sitePageRefs, discoverExternalPages, type GitProvenance } from './sources';
import { textifyMarkdown, textifyHtml } from './textify';
import { runChecks, type OwnRepoCheckContext } from './checks';
import { HopAwareLookup, type Lookup } from './lookup';
import { proposeMechanical } from './propose';
import { proposeProsePrerequisite } from './llm';
import { reverifyProposal, type GitApplyCheckFn } from './reverify';
import { applyUnifiedDiff } from './patch';
import { computeRunMeta, renderDocmendHeadline, type RunMeta, type LlmStats } from './analyze';
import { renderReportMarkdown, renderReportJson } from './report';
import type { Finding, PageFindings, Proposal, ProposalTarget } from './types';

// ---- shared file helpers ---------------------------------------------------------------

function readJson<T>(p: string, fallback: T): T {
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback;
}
function writeJson(p: string, v: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, stableStringify(v));
}
function log(s: string): void {
  process.stderr.write(s + '\n');
}

export interface SourcesFile {
  ownRepos: Record<string, { tree: string[]; packageJson: { scripts?: Record<string, string>; engines?: { node?: string } } | null; provenance: GitProvenance }>;
}

export interface RunState {
  protocolHash: string;
  protocolCommit: string | null;
  lastScanAt: string | null;
}

function gitHead(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function targetFor(manifest: Manifest): ProposalTarget {
  return {
    kind: manifest.source === 'own-repo' ? 'repo-file' : manifest.source === 'site' ? 'live-page' : 'external-snapshot',
    repo: manifest.repo,
    path: manifest.path,
    prReady: manifest.source === 'own-repo',
  };
}

// ---- scan -------------------------------------------------------------------------------

export interface ScanOptions {
  dataDir: string;
  protocol: Protocol;
  offline: boolean;
  failOn: string[];
  fetchImpl?: typeof fetch;
}

export async function cmdScan(opts: ScanOptions): Promise<number> {
  const corpusDir = resolve(opts.dataDir, 'corpus');
  const manifests = readManifests(corpusDir);
  if (manifests.length === 0) {
    log('no corpus; run with --live first to discover and snapshot pages');
    return 2;
  }
  const sources = readJson<SourcesFile>(resolve(opts.dataDir, 'sources.json'), { ownRepos: {} });
  const lookupCfg = {
    cachePath: resolve(opts.dataDir, 'lookup-cache.json'),
    mode: opts.offline ? ('snapshot' as const) : ('live' as const),
    userAgent: opts.protocol.corpusRule.fetch.user_agent,
    timeoutMs: opts.protocol.corpusRule.fetch.timeout_ms,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
  const lookup = new HopAwareLookup(lookupCfg);

  const pageFindings: PageFindings[] = [];
  let sawFailOn = false;
  for (const m of manifests) {
    const text = readFileSync(resolve(corpusDir, m.pageId, 'text.txt'), 'utf8');
    const ownCtx: OwnRepoCheckContext | null = m.source === 'own-repo' && m.repo ? sources.ownRepos[m.repo] ?? null : null;
    const result = await runChecks({ pageId: m.pageId, text, links: m.links, path: m.source === 'own-repo' ? m.path : null, selfUrl: m.url }, opts.protocol.checks, opts.protocol.corpusRule.link, m.source === 'external', lookup, ownCtx);
    pageFindings.push({ pageId: m.pageId, source: m.source, repo: m.repo, path: m.path, findings: result.findings, stats: result.stats });
    if (opts.failOn.length > 0 && result.findings.some((f) => f.counted && opts.failOn.includes(f.category))) sawFailOn = true;
  }
  lookup.save();
  writeJson(resolve(opts.dataDir, 'findings.json'), pageFindings);
  const state = readJson<RunState>(resolve(opts.dataDir, 'run-state.json'), { protocolHash: opts.protocol.hash, protocolCommit: gitHead(PKG_ROOT), lastScanAt: null });
  writeJson(resolve(opts.dataDir, 'run-state.json'), { protocolHash: opts.protocol.hash, protocolCommit: state.protocolCommit ?? gitHead(PKG_ROOT), lastScanAt: new Date().toISOString() });

  const total = pageFindings.reduce((a, pf) => a + pf.findings.filter((f) => f.counted).length, 0);
  log(`scanned ${manifests.length} pages; ${total} counted drift finding(s)`);
  return sawFailOn ? 1 : 0;
}

// ---- propose ----------------------------------------------------------------------------

export interface ProposeOptions {
  dataDir: string;
  llm: boolean;
  ledger?: Ledger;
  gatewayEnv?: NodeJS.ProcessEnv;
  /**
   * Overrides the prose-prerequisite generator (default: proposeProsePrerequisite, the real
   * $0-mock-by-default gateway call). cmdRepro passes one that carries a committed LLM
   * proposal through unchanged (matched by findingId) instead of re-deriving its text — see
   * cmdRepro below. Tests can use it the same way to exercise this branch without a gateway.
   */
  llmFn?: typeof proposeProsePrerequisite;
}

export async function cmdPropose(opts: ProposeOptions): Promise<number> {
  const findingsPath = resolve(opts.dataDir, 'findings.json');
  if (!existsSync(findingsPath)) {
    log('no findings.json; run scan first');
    return 2;
  }
  const pageFindings = readJson<PageFindings[]>(findingsPath, []);
  const corpusDir = resolve(opts.dataDir, 'corpus');
  const llmFn = opts.llmFn ?? proposeProsePrerequisite;
  const proposals: Proposal[] = [];
  let calls = 0;
  let errors = 0;
  let costUsd = 0;
  let mock = 0;

  for (const pf of pageFindings) {
    if (!corpusHas(corpusDir, pf.pageId)) continue;
    const manifest = readManifest(corpusDir, pf.pageId);
    const raw = readFileSync(resolve(corpusDir, pf.pageId, manifest.rawFile), 'utf8');
    const target = targetFor(manifest);
    for (const f of pf.findings) {
      if (!f.counted) continue;
      const mechanical = proposeMechanical(f, raw, target);
      if (mechanical) {
        proposals.push(mechanical);
        continue;
      }
      if (opts.llm && f.checkId === 'D-prereq') {
        const gatewayOpts: GatewayOptions = {};
        if (opts.ledger) gatewayOpts.ledger = opts.ledger;
        gatewayOpts.runId = 'propose';
        if (opts.gatewayEnv) gatewayOpts.env = opts.gatewayEnv;
        // D-prereq's line/excerpt/insertAfterLine are computed against the textified
        // text.txt (checks.ts runPrereqChecks; see snapshot.ts's own-repo/site/external
        // comment). raw.md is close enough to text.txt for own-repo pages — and IS the
        // file a repo-file proposal's diff must actually apply to — but raw.html for
        // site/external pages diverges sharply (no ``` fences, different line numbers), so
        // anchor the insertion diff on text.txt there instead.
        const prereqContent = target.kind === 'repo-file' ? raw : readManifestText(corpusDir, pf.pageId);
        const r = await llmFn(f, prereqContent, target, gatewayOpts);
        calls++;
        if (r.error) errors++;
        costUsd += r.costUsd;
        if (r.mock) mock++;
        if (r.proposal) proposals.push(r.proposal);
      }
    }
  }

  writeJson(resolve(opts.dataDir, 'proposals.json'), proposals);
  writeJson(resolve(opts.dataDir, 'llm-calls.json'), { calls, errors, costUsd, mock } satisfies LlmStats);
  log(`proposed ${proposals.length} fix(es) (${proposals.filter((p) => p.safe_to_auto_apply).length} safe to auto-apply)`);
  return 0;
}

// ---- verify -----------------------------------------------------------------------------

export interface VerifyOptions {
  dataDir: string;
  protocol: Protocol;
  offline: boolean;
  fetchImpl?: typeof fetch;
  gitApplyCheck?: GitApplyCheckFn;
}

export async function cmdVerify(opts: VerifyOptions): Promise<number> {
  const proposalsPath = resolve(opts.dataDir, 'proposals.json');
  if (!existsSync(proposalsPath)) {
    log('no proposals.json; run propose first');
    return 2;
  }
  const proposals = readJson<Proposal[]>(proposalsPath, []);
  const corpusDir = resolve(opts.dataDir, 'corpus');
  const sources = readJson<SourcesFile>(resolve(opts.dataDir, 'sources.json'), { ownRepos: {} });
  const lookupCfg = {
    cachePath: resolve(opts.dataDir, 'lookup-cache.json'),
    mode: opts.offline ? ('snapshot' as const) : ('live' as const),
    userAgent: opts.protocol.corpusRule.fetch.user_agent,
    timeoutMs: opts.protocol.corpusRule.fetch.timeout_ms,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
  const lookup: Lookup & { save?: () => void } = new HopAwareLookup(lookupCfg);

  for (const p of proposals) {
    if (!corpusHas(corpusDir, p.pageId)) {
      p.reverify = { status: 'fail', methods: [], evidence: { reason: 'page no longer snapshotted' }, checkedAt: new Date().toISOString() };
      continue;
    }
    const manifest = readManifest(corpusDir, p.pageId);
    const raw = readFileSync(resolve(corpusDir, p.pageId, manifest.rawFile), 'utf8');
    // Mirror cmdPropose's content choice for prose-prerequisite proposals so recheck-patched-text
    // and patch-applies operate on the same representation the diff was built against: raw.md
    // for repo-file targets (own-repo), text.txt for live-page/external-snapshot targets, whose
    // raw.html has no ``` fences and different line numbers than the D-prereq finding was
    // computed against (see the comment in cmdPropose above).
    const content = p.category === 'prose-prerequisite' && p.target.kind !== 'repo-file' ? readManifestText(corpusDir, p.pageId) : raw;
    const tree = p.target.repo ? sources.ownRepos[p.target.repo]?.tree : undefined;
    const deps: Parameters<typeof reverifyProposal>[1] = { lookup, rawContent: content, checks: opts.protocol.checks };
    if (tree) deps.tree = tree;
    if (opts.gitApplyCheck) deps.gitApplyCheck = opts.gitApplyCheck;
    p.reverify = await reverifyProposal(p, deps);
  }
  (lookup as HopAwareLookup).save();
  writeJson(proposalsPath, proposals);

  // Recompute run-meta.json — verify is the last stage before report/headline read it.
  const manifests = readManifests(corpusDir);
  const pageFindings = readJson<PageFindings[]>(resolve(opts.dataDir, 'findings.json'), []);
  const llm = readJson<LlmStats>(resolve(opts.dataDir, 'llm-calls.json'), { calls: 0, errors: 0, costUsd: 0, mock: 0 });
  const state = readJson<RunState>(resolve(opts.dataDir, 'run-state.json'), { protocolHash: opts.protocol.hash, protocolCommit: null, lastScanAt: null });
  const runMeta = computeRunMeta(manifests, pageFindings, proposals, llm, opts.protocol.hash, state.protocolCommit);
  writeJson(resolve(opts.dataDir, 'run-meta.json'), runMeta);

  const verified = proposals.filter((p) => p.reverify.status === 'pass').length;
  log(`verified ${verified}/${proposals.length} proposal(s)`);
  return 0;
}

// ---- report / headline -------------------------------------------------------------------

export interface ReportOptions {
  dataDir: string;
  outDir: string;
  protocol: Protocol;
  format: 'md' | 'json';
}

export function cmdReport(opts: ReportOptions): number {
  const runMeta = readJson<RunMeta | null>(resolve(opts.dataDir, 'run-meta.json'), null);
  if (!runMeta) {
    log('no run-meta.json; run verify first');
    return 2;
  }
  const pageFindings = readJson<PageFindings[]>(resolve(opts.dataDir, 'findings.json'), []);
  const proposals = readJson<Proposal[]>(resolve(opts.dataDir, 'proposals.json'), []);
  mkdirSync(opts.outDir, { recursive: true });
  if (opts.format === 'json') {
    writeFileSync(resolve(opts.outDir, 'report.json'), renderReportJson(runMeta, pageFindings, proposals));
  } else {
    writeFileSync(resolve(opts.outDir, 'report.md'), renderReportMarkdown(runMeta, pageFindings, proposals, opts.protocol.checks));
  }
  return 0;
}

export function cmdHeadline(opts: { dataDir: string; protocol: Protocol }): { code: number; text: string } {
  const runMeta = readJson<RunMeta | null>(resolve(opts.dataDir, 'run-meta.json'), null);
  if (!runMeta) return { code: 1, text: 'no run-meta.json yet (run verify first)' };
  const text = renderDocmendHeadline(opts.protocol.checks.headline_template, runMeta, opts.protocol.checks.no_proposals_text);
  return { code: 0, text };
}

// ---- run --live: sources -> snapshot -> scan -> propose -> verify, one process -----------

export interface RunLiveOptions {
  dataDir: string;
  protocol: Protocol;
  fetchImpl?: typeof fetch;
  llm: boolean;
  ledger?: Ledger;
}

export async function cmdRunLive(opts: RunLiveOptions): Promise<number> {
  const corpusDir = resolve(opts.dataDir, 'corpus');
  mkdirSync(corpusDir, { recursive: true });
  const { corpusRule } = opts.protocol;
  const sources: SourcesFile = { ownRepos: {} };

  for (const rule of corpusRule.own_repos) {
    const excludeRe = new RegExp(corpusRule.tree_exclude_re);
    const d = discoverOwnRepoPages(rule, excludeRe);
    let packageJson: SourcesFile['ownRepos'][string]['packageJson'] = null;
    const pkgPath = resolve(rule.local, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string>; engines?: { node?: string } };
        packageJson = {};
        if (pkg.scripts) packageJson.scripts = pkg.scripts;
        if (pkg.engines) packageJson.engines = pkg.engines;
      } catch {
        packageJson = null;
      }
    }
    sources.ownRepos[rule.id] = { tree: d.tree, packageJson, provenance: d.provenance };
    for (const ref of d.pageRefs) {
      const raw = d.files[ref.path]!;
      const t = textifyMarkdown(raw, null);
      snapshotOwnRepoPage(ref, raw, t, corpusDir);
    }
  }

  const fetchText = async (url: string): Promise<{ ok: boolean; status: number; text: string }> => {
    const { safeFetchText } = await import('@portfolio-builds/shared');
    const r = await safeFetchText(url, { timeoutMs: corpusRule.fetch.timeout_ms, maxBytes: corpusRule.fetch.max_bytes, headers: { 'user-agent': corpusRule.fetch.user_agent }, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    return r.ok ? { ok: true, status: r.status, text: r.text } : { ok: false, status: 0, text: '' };
  };
  const siteCandidates = await discoverSitePages(corpusRule.site, fetchText);
  for (const ref of sitePageRefs(corpusRule.site, siteCandidates)) {
    const page = await fetchText(ref.url!);
    if (!page.ok) continue;
    const t = textifyHtml(page.text, ref.url!);
    snapshotSitePage(ref, page.text, t, corpusDir);
  }

  const extRefs = discoverExternalPages({ id: corpusRule.external.id, pointer: corpusRule.external.pointer, id_prefix: corpusRule.external.id_prefix }, PKG_ROOT);
  for (const ref of extRefs) {
    const otrDir = resolve(PKG_ROOT, corpusRule.external.pointer, ref.path);
    const manifestPath = resolve(otrDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const otrManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { kind: 'html' | 'markdown'; title: string | null; links: string[]; rawFile: string };
    const otrRaw = readFileSync(resolve(otrDir, otrManifest.rawFile), 'utf8');
    const otrText = readFileSync(resolve(otrDir, 'text.txt'), 'utf8');
    snapshotExternalPage(ref, otrManifest, otrRaw, otrText, corpusDir);
  }

  writeJson(resolve(opts.dataDir, 'sources.json'), sources);

  const scanCode = await cmdScan({ dataDir: opts.dataDir, protocol: opts.protocol, offline: false, failOn: [], ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const proposeOpts: ProposeOptions = { dataDir: opts.dataDir, llm: opts.llm };
  if (opts.ledger) proposeOpts.ledger = opts.ledger;
  await cmdPropose(proposeOpts);
  await cmdVerify({ dataDir: opts.dataDir, protocol: opts.protocol, offline: false, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  cmdReport({ dataDir: opts.dataDir, outDir: OUT_DIR, protocol: opts.protocol, format: 'md' });
  return scanCode === 1 ? 1 : 0;
}

// ---- repro: re-derive offline, diff against committed files -----------------------------

function strip(s: string): string {
  return s.replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt":"<ignored>"').replace(/"checkedAt":\s*"[^"]*"/g, '"checkedAt":"<ignored>"');
}

export async function cmdRepro(opts: { dataDir: string; outDir: string; protocol: Protocol }): Promise<number> {
  const tmp = mkdtempSync(resolve(tmpdir(), 'docmend-repro-'));
  try {
    const tmpData = resolve(tmp, 'data');
    mkdirSync(tmpData, { recursive: true });
    // Re-run scan (offline: the committed lookup-cache.json only) into a scratch dir, reusing
    // the committed corpus (never re-fetched — repro is about re-deriving from what's already
    // committed, not re-crawling).
    execFileSync('cp', ['-R', resolve(opts.dataDir, 'corpus'), resolve(tmpData, 'corpus')]);
    if (existsSync(resolve(opts.dataDir, 'lookup-cache.json'))) execFileSync('cp', [resolve(opts.dataDir, 'lookup-cache.json'), resolve(tmpData, 'lookup-cache.json')]);
    if (existsSync(resolve(opts.dataDir, 'sources.json'))) execFileSync('cp', [resolve(opts.dataDir, 'sources.json'), resolve(tmpData, 'sources.json')]);

    await cmdScan({ dataDir: tmpData, protocol: opts.protocol, offline: true, failOn: [] });

    // Mechanical proposals re-derive bit-for-bit; LLM-sourced ones are carried through
    // unchanged from the committed proposals.json (re-deriving their text is not a $0/offline
    // operation) — matched by findingId. cmdPropose commits proposals in per-page/per-finding
    // traversal order, which INTERLEAVES mechanical and LLM proposals whenever a page has
    // both (e.g. a D-prereq finding before a D-rel-path finding on the same page, or an LLM
    // proposal on an earlier page than a mechanical one on a later page). stableStringify
    // preserves array order, so simply concatenating [recomputed mechanical, committed llm]
    // would not reproduce that interleaving bit-for-bit. Instead, replay the exact same
    // traversal via cmdPropose's llmFn seam: it recomputes every mechanical proposal fresh,
    // and for each D-prereq finding looks up the committed llm proposal by findingId — so the
    // push order matches the original run's exactly, with no separate merge step needed.
    const committed = readJson<Proposal[]>(resolve(opts.dataDir, 'proposals.json'), []);
    const committedLlmByFindingId = new Map(committed.filter((p) => p.source === 'llm').map((p) => [p.findingId, p]));
    const carryLlmProposal: typeof proposeProsePrerequisite = async (finding) => ({
      proposal: committedLlmByFindingId.get(finding.id) ?? null,
      error: null,
      costUsd: 0,
      mock: false,
    });
    await cmdPropose({ dataDir: tmpData, llm: true, llmFn: carryLlmProposal });
    // Carry the committed llm-calls.json through unchanged (same reasoning as above).
    if (existsSync(resolve(opts.dataDir, 'llm-calls.json'))) execFileSync('cp', [resolve(opts.dataDir, 'llm-calls.json'), resolve(tmpData, 'llm-calls.json')]);
    if (existsSync(resolve(opts.dataDir, 'run-state.json'))) execFileSync('cp', [resolve(opts.dataDir, 'run-state.json'), resolve(tmpData, 'run-state.json')]);

    await cmdVerify({ dataDir: tmpData, protocol: opts.protocol, offline: true });

    const files = ['findings.json', 'proposals.json', 'run-meta.json'];
    let same = true;
    const diffs: string[] = [];
    for (const f of files) {
      const a = existsSync(resolve(opts.dataDir, f)) ? strip(readFileSync(resolve(opts.dataDir, f), 'utf8')) : '';
      const b = existsSync(resolve(tmpData, f)) ? strip(readFileSync(resolve(tmpData, f), 'utf8')) : '';
      if (a !== b) {
        same = false;
        diffs.push(f);
      }
    }
    log(same ? `repro OK: findings.json, proposals.json, run-meta.json re-derived bit-for-bit` : `repro FAILED: differs in ${diffs.join(', ')}`);
    return same ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- citty wrapper (real entry point) ----------------------------------------------------

function resolveDataDir(): string {
  return process.env['DOCMEND_DATA_DIR'] || DATA_DIR;
}
function resolveOutDir(): string {
  return process.env['DOCMEND_OUT_DIR'] || OUT_DIR;
}

async function withExitCode(fn: () => Promise<number> | number): Promise<void> {
  try {
    const code = await fn();
    process.exit(code);
  } catch (err) {
    log(`fatal: ${(err as Error).stack ?? String(err)}`);
    process.exit(3);
  }
}

const main = defineCommand({
  meta: { name: 'docmend', description: 'Finds doc drift, proposes machine-reverifiable fixes.' },
  subCommands: {
    scan: defineCommand({
      meta: { description: 'Run the D-* drift checks over the committed corpus.' },
      args: {
        offline: { type: 'boolean', description: 'Never touch the network; snapshot-mode lookup only.' },
        'fail-on': { type: 'string', description: 'Comma-separated categories; exit 1 if any counted finding matches.' },
      },
      run: async ({ args }) => {
        await withExitCode(() => cmdScan({ dataDir: resolveDataDir(), protocol: loadProtocol(), offline: Boolean(args['offline']), failOn: args['fail-on'] ? String(args['fail-on']).split(',').filter(Boolean) : [] }));
      },
    }),
    propose: defineCommand({
      meta: { description: 'Generate mechanical (and, with --llm, prose-prerequisite) fix proposals.' },
      args: {
        offline: { type: 'boolean', description: 'Accepted for symmetry with scan/verify; propose never calls the network itself.' },
        llm: { type: 'boolean', description: 'Also propose prose-prerequisite fixes via the LLM gateway.' },
      },
      run: async ({ args }) => {
        await withExitCode(() => cmdPropose({ dataDir: resolveDataDir(), llm: Boolean(args['llm']) }));
      },
    }),
    verify: defineCommand({
      meta: { description: 'Independently re-verify every proposal; recomputes run-meta.json.' },
      args: { offline: { type: 'boolean', description: 'Never touch the network; snapshot-mode lookup only.' } },
      run: async ({ args }) => {
        await withExitCode(() => cmdVerify({ dataDir: resolveDataDir(), protocol: loadProtocol(), offline: Boolean(args['offline']) }));
      },
    }),
    report: defineCommand({
      meta: { description: 'Render out/report.md or out/report.json from committed data.' },
      args: { format: { type: 'string', description: 'md or json', default: 'md' } },
      run: async ({ args }) => {
        const format = args['format'] === 'json' ? 'json' : 'md';
        await withExitCode(() => cmdReport({ dataDir: resolveDataDir(), outDir: resolveOutDir(), protocol: loadProtocol(), format }));
      },
    }),
    run: defineCommand({
      meta: { description: 'Full pipeline in one process: discover, snapshot, scan, propose, verify, report.' },
      args: {
        live: { type: 'boolean', description: 'Required: confirms this invocation touches the network.' },
        llm: { type: 'boolean', description: 'Also run the LLM prose-prerequisite step.' },
      },
      run: async ({ args }) => {
        if (!args['live']) {
          log('run requires --live (it discovers and snapshots pages over the network)');
          process.exit(2);
        }
        await withExitCode(() => cmdRunLive({ dataDir: resolveDataDir(), protocol: loadProtocol(), llm: Boolean(args['llm']) }));
      },
    }),
    headline: defineCommand({
      meta: { description: 'Print the headline sentence rendered from the committed run-meta.json.' },
      run: async () => {
        const { code, text } = cmdHeadline({ dataDir: resolveDataDir(), protocol: loadProtocol() });
        process.stdout.write(text + '\n');
        process.exit(code);
      },
    }),
    repro: defineCommand({
      meta: { description: 'Re-derive findings/proposals/run-meta offline and diff against committed files.' },
      run: async () => {
        await withExitCode(() => cmdRepro({ dataDir: resolveDataDir(), outDir: resolveOutDir(), protocol: loadProtocol() }));
      },
    }),
  },
});

const isMain = (() => {
  try {
    return resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) {
  void runMain(main);
}
