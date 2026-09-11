// CLI: seed -> candidates -> snapshot -> analyze -> headline -> repro.
// Usage: node --import tsx src/cli.ts <command> [--limit N] [--live|--snapshot]

import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { renderHeadline, stableStringify } from '@portfolio-builds/shared';
import { loadProtocol, DATA_DIR, PKG_ROOT } from './protocol';
import { fetchSeed, readSeed, buildCandidates, type Candidate, type Exclusion } from './seed';
import { snapshotCandidate, corpusHas } from './snapshot';
import { CachedLookup } from './registries';
import { analyzeCorpus, writeAnalysis, type RunMeta } from './analyze';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? '') : null;
};
const has = (name: string) => args.includes(`--${name}`);
const log = (s: string) => process.stderr.write(s + '\n');

const protocol = loadProtocol();
const SEED_DIR = resolve(DATA_DIR, 'seed');
const CORPUS_DIR = resolve(DATA_DIR, 'corpus');
const CACHE_PATH = resolve(DATA_DIR, 'lookup-cache.json');
const CANDIDATES = resolve(DATA_DIR, 'candidates.json');
const LEDGER = resolve(DATA_DIR, 'exclusion-ledger.json');
const STATE = resolve(DATA_DIR, 'run-state.json');

interface RunState {
  protocolHash: string;
  protocolCommit: string | null;
  seededAt: string | null;
}

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PKG_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readJson<T>(p: string, fallback: T): T {
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback;
}

async function main(): Promise<number> {
  mkdirSync(DATA_DIR, { recursive: true });
  switch (cmd) {
    case 'seed': {
      const state = readJson<RunState>(STATE, { protocolHash: protocol.hash, protocolCommit: gitHead(), seededAt: null });
      if (state.seededAt && !has('force')) {
        log(`already seeded at ${state.seededAt}; pass --force to re-seed (drift becomes a finding)`);
        return 1;
      }
      const { files, failures } = await fetchSeed(protocol, { seedDir: SEED_DIR, log });
      if (failures.length) log(`seed failures: ${failures.join('; ')}`);
      if (files.length === 0) return 1;
      writeFileSync(STATE, stableStringify({ protocolHash: protocol.hash, protocolCommit: state.protocolCommit ?? gitHead(), seededAt: new Date().toISOString() }));
      log(`seeded ${files.length}/${protocol.corpusRule.seed.queries.length} queries`);
      return failures.length ? 2 : 0;
    }
    case 'candidates': {
      const seeds = readSeed(SEED_DIR);
      if (seeds.length === 0) {
        log('no seed files; run seed first');
        return 1;
      }
      const { candidates, exclusions } = buildCandidates(seeds, new Date().toISOString());
      writeFileSync(CANDIDATES, stableStringify(candidates));
      const prior = readJson<Exclusion[]>(LEDGER, []).filter((e) => e.stage !== 'candidates');
      writeFileSync(LEDGER, stableStringify([...exclusions, ...prior]));
      log(`${candidates.length} candidates from ${seeds.reduce((a, s) => a + s.items.length, 0)} seed items; ${exclusions.length} excluded at candidate stage`);
      return 0;
    }
    case 'snapshot': {
      const candidates = readJson<Candidate[]>(CANDIDATES, []);
      if (candidates.length === 0) {
        log('no candidates; run candidates first');
        return 1;
      }
      const target = protocol.corpusRule.target_n;
      // --limit caps candidates PROCESSED this invocation (trials); default walks the whole list
      // until `target` pages exist (the frozen stop rule).
      const limit = flag('limit') ? Number(flag('limit')) : candidates.length;
      mkdirSync(CORPUS_DIR, { recursive: true });
      const ledger = readJson<Exclusion[]>(LEDGER, []);
      const tried = new Set(ledger.filter((e) => e.stage === 'snapshot').map((e) => e.full_name));
      let have = candidates.filter((c) => corpusHas(CORPUS_DIR, c.id)).length;
      let processed = 0;
      for (const c of candidates) {
        if (have >= target || processed >= limit) break;
        if (corpusHas(CORPUS_DIR, c.id) || tried.has(c.full_name)) continue;
        processed++;
        const r = await snapshotCandidate(c, CORPUS_DIR, { protocol, log });
        if (r.status === 'snapshotted') {
          have++;
          log(`[${have}/${target}] #${c.rank} ${c.full_name} <- ${r.manifest.probe} ${r.manifest.url} (${r.manifest.bytes} B)`);
        } else {
          ledger.push(r.exclusion);
          writeFileSync(LEDGER, stableStringify(ledger));
          log(`      #${c.rank} ${c.full_name} excluded: ${r.exclusion.reason}`);
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      log(`corpus: ${have}/${target} pages; ledger: ${ledger.length} exclusions`);
      return 0;
    }
    case 'analyze': {
      const mode = has('snapshot') ? 'snapshot' : 'live';
      const lookup = new CachedLookup({ cachePath: CACHE_PATH, mode, userAgent: protocol.corpusRule.fetch.user_agent, timeoutMs: protocol.corpusRule.fetch.timeout_ms, onFetch: (k) => log(`  lookup ${k}`) });
      const state = readJson<RunState>(STATE, { protocolHash: protocol.hash, protocolCommit: null, seededAt: null });
      const exclusions = readJson<Exclusion[]>(LEDGER, []);
      const { pages, runMeta } = await analyzeCorpus(protocol, CORPUS_DIR, lookup, {
        protocolCommit: state.protocolCommit,
        seededAt: state.seededAt,
        exclusions,
        targetN: protocol.corpusRule.target_n,
        lookupCacheEntries: () => lookup.size,
        log,
      });
      lookup.save();
      writeAnalysis(DATA_DIR, pages, runMeta);
      log(`analyzed ${pages.length} pages; k0=${runMeta.k0} k1=${runMeta.k1}; cache ${lookup.size} entries`);
      return 0;
    }
    case 'headline': {
      const meta = readJson<RunMeta | null>(resolve(DATA_DIR, 'run-meta.json'), null);
      if (!meta || !meta.pct) {
        log('no run-meta.json (or no pages yet); the headline is not renderable until the run produces it');
        return 1;
      }
      const sentence = renderHeadline(protocol.checks.headline_template, {
        n: meta.n,
        date: meta.snapshotDate,
        k0: meta.k0,
        n0: meta.n0,
        k1: meta.k1,
        ...meta.pct,
      });
      process.stdout.write(sentence + '\n');
      log(`  protocol ${meta.protocolHash.slice(0, 16)}… @ ${meta.protocolCommit?.slice(0, 10) ?? '?'} · seeded ${meta.seededAt ?? '?'} · llm cost $${meta.llmCostUsd.toFixed(2)} (${meta.llmCalls} calls)`);
      return 0;
    }
    case 'repro': {
      // Recompute findings + run-meta from the committed snapshot and cache, network-free,
      // into a temp dir; diff against the committed files (generatedAt excluded).
      const tmp = mkdtempSync(resolve(tmpdir(), 'otr-repro-'));
      try {
        const lookup = new CachedLookup({ cachePath: CACHE_PATH, mode: 'snapshot', userAgent: 'repro', timeoutMs: 1 });
        const state = readJson<RunState>(STATE, { protocolHash: protocol.hash, protocolCommit: null, seededAt: null });
        const exclusions = readJson<Exclusion[]>(LEDGER, []);
        const { pages, runMeta } = await analyzeCorpus(protocol, CORPUS_DIR, lookup, {
          protocolCommit: state.protocolCommit,
          seededAt: state.seededAt,
          exclusions,
          targetN: protocol.corpusRule.target_n,
          lookupCacheEntries: () => lookup.size,
        });
        writeAnalysis(tmp, pages, runMeta);
        const strip = (s: string) => s.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "<ignored>"');
        const a = strip(readFileSync(resolve(DATA_DIR, 'findings.json'), 'utf8'));
        const b = strip(readFileSync(resolve(tmp, 'findings.json'), 'utf8'));
        const c = strip(readFileSync(resolve(DATA_DIR, 'run-meta.json'), 'utf8'));
        const d = strip(readFileSync(resolve(tmp, 'run-meta.json'), 'utf8'));
        const same = a === b && c === d;
        log(same ? `repro OK: findings.json and run-meta.json re-derived bit-for-bit (${pages.length} pages)` : 'repro FAILED: recomputed output differs from committed files');
        return same ? 0 : 1;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    default:
      log('commands: seed | candidates | snapshot [--limit N] | analyze [--snapshot] | headline | repro');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`fatal: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  },
);
