#!/usr/bin/env node
// model-regress CLI (citty for flag parsing). Exit codes: 0 = ok / no regression, 1 =
// regression / assertion or threshold failure, 2 = usage. `--json` prints a machine record
// on stdout; human notes go to stderr. No command here ever calls the network on its own —
// a real run happens only when the spend cap is raised (main-session step); `--mock` runs
// the whole pipeline offline at $0.

import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'citty';
import { Ledger, stableStringify, type LlmSpec } from '@portfolio-builds/shared';
import { loadProtocol, PKG_ROOT, DATA_DIR, GOLDEN_PATH, type Protocol, type RunState } from './protocol';
import { generateGolden, goldenHash, loadGolden, type GoldenItem } from './golden';
import { estimateRun } from './estimate';
import { runCondition, type ConditionRun } from './runner';
import { compare, type Comparison } from './compare';
import { buildRunMeta, headlineFromMeta, type RunMeta } from './report';
import { ciFromComparison } from './ci';
import { minDetectableEffect, requiredN } from './stats';

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}
export interface CliPaths {
  dataDir: string;
  goldenPath: string;
}

const defaultIO: CliIO = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s + '\n') };

const USAGE = [
  'model-regress <command> [--json]',
  '  golden gen [--seed N] [--n N] [--out path]   generate the deterministic golden set',
  '  golden hash                                  print the protocol golden hash',
  '  estimate --all                               pre-call cost estimate per condition',
  '  run --condition A [--model M] [--mock]       run one condition over the golden set',
  '  compare [--a A --b B --noise A-repeat]        build the paired comparison + run-meta',
  '  headline                                     render the headline from run-meta.json',
  '  ci [--a --b --noise --max-drop-pp --max-cost-increase-pct]   exit-code gate',
  '  power --n N --discordant R [--power P]        MDE / required-n calculator',
  '  repro                                        re-derive comparison.json + run-meta.json',
].join('\n');

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PKG_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readJson<T>(p: string): T | null {
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
}

function num(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a string flag from citty's parsed args (undefined when absent or non-string). */
function flagStr(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key];
  return typeof v === 'string' ? v : undefined;
}

/** Load the committed golden set (verified) or regenerate it deterministically from the protocol. */
function loadGoldenForRun(proto: Protocol, paths: CliPaths, io: CliIO): GoldenItem[] {
  if (existsSync(paths.goldenPath)) return loadGolden(paths.goldenPath, { expectedHash: proto.goldenHash });
  io.err(`note: ${paths.goldenPath} not committed yet; regenerating the golden set from the frozen protocol`);
  return generateGolden({ seed: proto.experiment.golden.seed, n: proto.experiment.golden.n });
}

/** A perfect offline responder: answers each prompt with that item's exact expected JSON. */
function perfectMock(set: GoldenItem[]): (spec: LlmSpec) => string {
  const byPrompt = new Map(set.map((i) => [i.prompt, JSON.stringify(i.expected)]));
  return (spec) => byPrompt.get(spec.user) ?? '{}';
}

function runPath(paths: CliPaths, name: string): string {
  return resolve(paths.dataDir, 'runs', `${name}.json`);
}

function loadRun(paths: CliPaths, nameOrPath: string): ConditionRun | null {
  const p = existsSync(nameOrPath) ? nameOrPath : runPath(paths, nameOrPath);
  return readJson<ConditionRun>(p);
}

function conditionModel(proto: Protocol, name: string): string | null {
  return proto.experiment.conditions.find((c) => c.name === name)?.model ?? null;
}

// ---- commands ----------------------------------------------------------------------------

function cmdGolden(rest: string[], io: CliIO, json: boolean, paths: CliPaths, proto: Protocol): number {
  const sub = rest[0];
  if (sub === 'gen') {
    const a = parseArgs(rest.slice(1), { seed: { type: 'string' }, n: { type: 'string' }, out: { type: 'string' } });
    const seed = num(a['seed'], proto.experiment.golden.seed);
    const n = num(a['n'], proto.experiment.golden.n);
    const out = flagStr(a, 'out') || paths.goldenPath;
    const set = generateGolden({ seed, n });
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(out, stableStringify(set));
    const hash = goldenHash(set);
    if (json) io.out(JSON.stringify({ written: out, n: set.length, seed, hash }) + '\n');
    else io.err(`wrote ${set.length} golden items to ${out} (hash ${hash.slice(0, 16)}…)`);
    return 0;
  }
  if (sub === 'hash') {
    const hash = proto.goldenHash;
    if (existsSync(paths.goldenPath)) loadGolden(paths.goldenPath, { expectedHash: hash }); // throws on drift
    if (json) io.out(JSON.stringify({ goldenHash: hash, committed: existsSync(paths.goldenPath) }) + '\n');
    else io.out(hash + '\n');
    return 0;
  }
  io.err('usage: golden gen | golden hash');
  return 2;
}

function cmdEstimate(rest: string[], io: CliIO, json: boolean, proto: Protocol): number {
  const a = parseArgs(rest, { all: { type: 'boolean' } });
  void a;
  const set = generateGolden({ seed: proto.experiment.golden.seed, n: proto.experiment.golden.n });
  const rows = proto.experiment.conditions.map((c) => {
    const e = estimateRun(set, c.model, { system: proto.experiment.task.system, maxTokens: proto.experiment.task.maxTokens });
    return { name: c.name, model: c.model, ...e };
  });
  const totals = rows.reduce(
    (acc, r) => ({ expectedUsd: acc.expectedUsd + r.expectedUsd, ceilingUsd: acc.ceilingUsd + r.ceilingUsd, calls: acc.calls + r.calls }),
    { expectedUsd: 0, ceilingUsd: 0, calls: 0 },
  );
  if (json) {
    io.out(JSON.stringify({ rows, totals, cap_usd: proto.experiment.spend.cap_usd }) + '\n');
  } else {
    for (const r of rows) io.err(`${r.name} (${r.model}): expected $${r.expectedUsd.toFixed(4)}, ceiling $${r.ceilingUsd.toFixed(4)}, ${r.calls} calls`);
    io.err(`TOTAL: expected $${totals.expectedUsd.toFixed(4)}, ceiling $${totals.ceilingUsd.toFixed(4)}, ${totals.calls} calls (cap $${proto.experiment.spend.cap_usd})`);
  }
  return 0;
}

async function cmdRun(rest: string[], io: CliIO, json: boolean, paths: CliPaths, proto: Protocol): Promise<number> {
  const a = parseArgs(rest, { condition: { type: 'string' }, model: { type: 'string' }, mock: { type: 'boolean' } });
  const name = flagStr(a, 'condition') || 'A';
  const model = flagStr(a, 'model') || conditionModel(proto, name);
  if (!model) {
    io.err(`unknown condition '${name}'; pass --model explicitly`);
    return 2;
  }
  const set = loadGoldenForRun(proto, paths, io);
  const ledger = new Ledger();
  const run = await runCondition(
    set,
    { name, model, maxTokens: proto.experiment.task.maxTokens },
    {
      system: proto.experiment.task.system,
      ledger,
      ...(a['mock'] ? { mock: perfectMock(set) } : {}),
      runId: name,
    },
  );
  ledger.close();
  mkdirSync(resolve(paths.dataDir, 'runs'), { recursive: true });
  writeFileSync(runPath(paths, name), stableStringify(run));
  writeRunState(paths, proto, { ranAt: new Date().toISOString() });
  if (json) io.out(JSON.stringify({ name, model, n: run.n, completed: run.completed, k: run.k, kParse: run.kParse, skipped: run.skipped, errors: run.errors, totalCostUsd: run.totalCostUsd }) + '\n');
  else io.err(`ran ${name} (${model}): ${run.k}/${run.completed} exact-json pass, ${run.skipped} skipped, ${run.errors} errored, $${run.totalCostUsd.toFixed(4)}`);
  return 0;
}

function writeRunState(paths: CliPaths, proto: Protocol, patch: Partial<RunState>): RunState {
  const p = resolve(paths.dataDir, 'run-state.json');
  const prior = readJson<RunState>(p);
  const frozenAt = `${proto.experiment.frozen_on}T00:00:00.000Z`;
  const state: RunState = {
    protocolHash: proto.hash,
    goldenHash: proto.goldenHash,
    protocolCommit: prior?.protocolCommit ?? gitHead(),
    frozenAt: prior?.frozenAt ?? frozenAt,
    ranAt: prior?.ranAt ?? null,
    ...patch,
  };
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(p, stableStringify(state));
  return state;
}

interface RunTriple {
  a: ConditionRun;
  b: ConditionRun;
  noise: ConditionRun | null;
}

/**
 * Load the run files, build the paired comparison, and return the loaded runs alongside it so
 * callers can source real ledger figures (cost + call count) straight from the runs — the
 * Comparison summary keeps only A's and B's cost, so the A-repeat (noise) figures are only
 * available here.
 */
function buildComparisonFromRuns(
  paths: CliPaths,
  proto: Protocol,
  aName: string,
  bName: string,
  noiseName: string | null,
): { cmp: Comparison; runs: RunTriple } | null {
  const a = loadRun(paths, aName);
  const b = loadRun(paths, bName);
  if (!a || !b) return null;
  const noise = noiseName ? loadRun(paths, noiseName) : null;
  const cmp = compare(a, b, noise ?? undefined, proto.experiment.decision_rule);
  return { cmp, runs: { a, b, noise } };
}

/**
 * The real number of gateway calls a run made: every completed item made one call, and when
 * the spend cap was hit mid-run exactly one more call triggered it (every item after that is a
 * pure skip that never reached the gateway). On the no-skip happy path this is just `completed`.
 */
function realLedgerCalls(run: ConditionRun): number {
  return run.completed + (run.skipped > 0 ? 1 : 0);
}

function cmdCompare(rest: string[], io: CliIO, json: boolean, paths: CliPaths, proto: Protocol): number {
  const a = parseArgs(rest, { a: { type: 'string' }, b: { type: 'string' }, noise: { type: 'string' } });
  const aName = flagStr(a, 'a') || 'A';
  const bName = flagStr(a, 'b') || 'B';
  const noiseName = flagStr(a, 'noise') ?? 'A-repeat';
  const built = buildComparisonFromRuns(paths, proto, aName, bName, noiseName);
  if (!built) {
    io.err('missing run files; run each condition first');
    return 2;
  }
  const { cmp, runs } = built;
  const state = readJson<RunState>(resolve(paths.dataDir, 'run-state.json'));
  // Real ledger figures come straight from the persisted runs — including the A-repeat (noise)
  // condition, whose cost and calls the Comparison summary discards — so the committed run-meta
  // reports the whole S-RD-1 spend and call count, not just A+B.
  const ledgerTotalUsd = runs.a.totalCostUsd + runs.b.totalCostUsd + (runs.noise?.totalCostUsd ?? 0);
  const ledgerCalls = realLedgerCalls(runs.a) + realLedgerCalls(runs.b) + (runs.noise ? realLedgerCalls(runs.noise) : 0);
  const meta = buildRunMeta(proto, cmp, {
    runDate: new Date().toISOString().slice(0, 10),
    ledgerTotalUsd,
    ledgerCalls,
    protocolCommit: state?.protocolCommit ?? gitHead(),
    frozenAt: state?.frozenAt ?? `${proto.experiment.frozen_on}T00:00:00.000Z`,
    ranAt: state?.ranAt ?? new Date().toISOString(),
    generatedAt: new Date().toISOString(),
  });
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(resolve(paths.dataDir, 'comparison.json'), stableStringify(cmp));
  writeFileSync(resolve(paths.dataDir, 'run-meta.json'), stableStringify(meta));
  if (json) io.out(JSON.stringify({ nPaired: cmp.nPaired, diffPp: cmp.diffPp, loPp: cmp.loPp, hiPp: cmp.hiPp, mcnemarP: cmp.mcnemarP, headline: meta.headline }) + '\n');
  else io.err(meta.headline ?? `paired n=${cmp.nPaired}, diff ${cmp.diffPp.toFixed(1)}pp — headline not renderable yet`);
  return 0;
}

function cmdHeadline(io: CliIO, json: boolean, paths: CliPaths, proto: Protocol): number {
  const meta = readJson<RunMeta>(resolve(paths.dataDir, 'run-meta.json'));
  if (!meta || !meta.headlineValues) {
    io.err('no run-meta.json with headline values yet; the headline is not renderable until a paired run produces it');
    return 1;
  }
  const sentence = headlineFromMeta(proto, meta);
  if (json) io.out(JSON.stringify({ headline: sentence }) + '\n');
  else io.out(sentence + '\n');
  return 0;
}

function cmdCi(rest: string[], io: CliIO, json: boolean, paths: CliPaths, proto: Protocol): number {
  const a = parseArgs(rest, {
    a: { type: 'string' },
    b: { type: 'string' },
    noise: { type: 'string' },
    'max-drop-pp': { type: 'string' },
    'max-cost-increase-pct': { type: 'string' },
  });
  const built = buildComparisonFromRuns(paths, proto, flagStr(a, 'a') || 'A', flagStr(a, 'b') || 'B', flagStr(a, 'noise') ?? 'A-repeat');
  if (!built) {
    io.err('missing run files; run each condition first');
    return 2;
  }
  const cmp = built.cmp;
  const thresholds = {
    maxDropPp: num(a['max-drop-pp'], proto.experiment.ci_thresholds.max_drop_pp),
    maxCostIncreasePct: num(a['max-cost-increase-pct'], proto.experiment.ci_thresholds.max_cost_increase_pct),
  };
  const res = ciFromComparison(cmp, thresholds);
  if (json) io.out(JSON.stringify({ code: res.code, verdict: res.verdict, diffPp: res.diffPp, costIncreasePct: res.costIncreasePct, reasons: res.reasons }) + '\n');
  else {
    io.err(`verdict: ${res.verdict} (${res.pass ? 'PASS' : 'FAIL'})`);
    for (const r of res.reasons) io.err(`  - ${r}`);
  }
  return res.code;
}

function cmdPower(rest: string[], io: CliIO, json: boolean): number {
  const a = parseArgs(rest, { n: { type: 'string' }, discordant: { type: 'string' }, power: { type: 'string' } });
  const n = num(a['n'], 40);
  const discordant = num(a['discordant'], 0.2);
  const power = num(a['power'], 0.8);
  const mdePp = minDetectableEffect(n, discordant, power);
  const forDeltas = [5, 10, 15].map((d) => ({ deltaPp: d, requiredN: requiredN(d, discordant, power) }));
  if (json) io.out(JSON.stringify({ n, discordant, power, mdePp, requiredN: forDeltas }) + '\n');
  else {
    io.err(`MDE at n=${n}, discordant rate ${discordant}, power ${power}: ${mdePp.toFixed(2)} pp`);
    for (const f of forDeltas) io.err(`  to detect ${f.deltaPp} pp → need n=${f.requiredN}`);
  }
  return 0;
}

function stripGeneratedAt(s: string): string {
  return s.replace(/"generatedAt": "[^"]*"/g, '"generatedAt": "<ignored>"');
}

function cmdRepro(io: CliIO, json: boolean, paths: CliPaths, proto: Protocol): number {
  const committedCmpPath = resolve(paths.dataDir, 'comparison.json');
  const committedMetaPath = resolve(paths.dataDir, 'run-meta.json');
  const meta = readJson<RunMeta>(committedMetaPath);
  const built = buildComparisonFromRuns(paths, proto, 'A', 'B', 'A-repeat');
  if (!built || !meta || !existsSync(committedCmpPath)) {
    if (json) io.out(JSON.stringify({ repro: 'noop', note: 'no committed run yet; repro is a no-op before any run' }) + '\n');
    else io.err('repro: no committed run yet — nothing to re-derive (a no-op before any run)');
    return 0;
  }
  const cmp = built.cmp;
  const tmp = mkdtempSync(resolve(tmpdir(), 'mr-repro-'));
  try {
    const meta2 = buildRunMeta(proto, cmp, {
      runDate: meta.runDate,
      ledgerTotalUsd: meta.cost.ledgerTotalUsd,
      ledgerCalls: meta.cost.ledgerCalls,
      protocolCommit: meta.protocolCommit,
      frozenAt: meta.frozenAt,
      ranAt: meta.ranAt,
      generatedAt: 'repro',
    });
    const cmpCommitted = readFileSync(committedCmpPath, 'utf8');
    const metaCommitted = readFileSync(committedMetaPath, 'utf8');
    const cmpSame = cmpCommitted === stableStringify(cmp);
    const metaSame = stripGeneratedAt(metaCommitted) === stripGeneratedAt(stableStringify(meta2));
    const ok = cmpSame && metaSame;
    if (json) io.out(JSON.stringify({ repro: ok ? 'ok' : 'mismatch', comparison: cmpSame, runMeta: metaSame }) + '\n');
    else io.err(ok ? `repro OK: comparison.json and run-meta.json re-derived bit-for-bit (n=${cmp.nPaired})` : `repro FAILED (comparison=${cmpSame}, run-meta=${metaSame})`);
    return ok ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface RunCliOptions {
  io?: CliIO;
  paths?: Partial<CliPaths>;
  protocol?: Protocol;
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<number> {
  const io = opts.io ?? defaultIO;
  const proto = opts.protocol ?? loadProtocol();
  const paths: CliPaths = { dataDir: opts.paths?.dataDir ?? DATA_DIR, goldenPath: opts.paths?.goldenPath ?? GOLDEN_PATH };
  const json = argv.includes('--json');
  const cmd = argv[0];
  const rest = argv.slice(1).filter((x) => x !== '--json');
  try {
    switch (cmd) {
      case 'golden':
        return cmdGolden(rest, io, json, paths, proto);
      case 'estimate':
        return cmdEstimate(rest, io, json, proto);
      case 'run':
        return await cmdRun(rest, io, json, paths, proto);
      case 'compare':
        return cmdCompare(rest, io, json, paths, proto);
      case 'headline':
        return cmdHeadline(io, json, paths, proto);
      case 'ci':
        return cmdCi(rest, io, json, paths, proto);
      case 'power':
        return cmdPower(rest, io, json);
      case 'repro':
        return cmdRepro(io, json, paths, proto);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.err(USAGE);
        return 2;
      default:
        io.err(`unknown command: ${cmd}\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
    return 1;
  }
}

// Entry point (only when invoked directly, not when imported by tests).
const invokedDirectly = process.argv[1] !== undefined && /cli\.(ts|js|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
