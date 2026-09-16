#!/usr/bin/env node
// CLI: extract | capture | analyze | headline | repro | estimate | budget | report.
// Usage: node --import tsx src/cli.ts <command> [flags] (or the `lca` npm script).
// Every command accepts --json. Exit codes: 0 ok, 1 check-failed-or-no-run, 2 usage.
//
// Flag parsing goes through citty's parseArgs per command (not citty's runMain, which only
// ever exits 0/1 — this package needs the 3-way 0/1/2 contract, so the top-level dispatch
// and every exit code are handled here).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ArgsDef } from 'citty';
import { Ledger, makeTokenizer, requireSalt, stableStringifyLine } from '@portfolio-builds/shared';
import { DATA_DIR, loadPolicy, type Protocol } from './protocol';
import { extractClaudeCode } from './transcripts';
import { importLedger } from './traffic';
import { analyze as analyzeReport, buildHeadlineValues, renderReportHeadline, report as renderReport, type ReportFormat } from './report';
import type { CallFinding, RunMeta } from './counterfactual';
import { estimateStep, type PlannedCall } from './estimate';
import { BudgetGuard } from './budget';

export interface CliIO {
  log: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: CliIO = {
  log: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
};

const COMMANDS = ['extract', 'capture', 'analyze', 'headline', 'repro', 'estimate', 'budget', 'report'] as const;

function usageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseOrUsage<T extends ArgsDef>(rawArgs: string[], def: T): { args: ReturnType<typeof parseArgs<T>> } | { usageError: string } {
  try {
    return { args: parseArgs(rawArgs, def) };
  } catch (err) {
    return { usageError: usageOf(err) };
  }
}

async function cmdExtract(rawArgs: string[], io: CliIO, dataDir: string): Promise<number> {
  const parsed = parseOrUsage(rawArgs, {
    root: { type: 'string', required: true },
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    json: { type: 'boolean', default: false },
  });
  if ('usageError' in parsed) {
    io.err(parsed.usageError);
    return 2;
  }
  const { args } = parsed;

  let salt: string;
  try {
    salt = requireSalt();
  } catch (err) {
    io.err(usageOf(err));
    return 1;
  }

  const tokenizer = makeTokenizer(salt);
  const { records, tallies } = await extractClaudeCode(args.root, tokenizer, { from: args.from, to: args.to });

  const trafficDir = resolve(dataDir, 'traffic');
  mkdirSync(trafficDir, { recursive: true });
  writeFileSync(resolve(trafficDir, 'claude-code.jsonl'), records.map((r) => stableStringifyLine(r)).join(''));

  const summary = { n: records.length, tallies };
  io.log(args.json ? JSON.stringify(summary) : `extracted ${records.length} calls; excluded: ${JSON.stringify(tallies)}`);
  return 0;
}

async function cmdCapture(rawArgs: string[], io: CliIO): Promise<number> {
  const parsed = parseOrUsage(rawArgs, {
    ledger: { type: 'string', required: true },
    out: { type: 'string', required: true },
    json: { type: 'boolean', default: false },
  });
  if ('usageError' in parsed) {
    io.err(parsed.usageError);
    return 2;
  }
  const { args } = parsed;

  const { records, tallies } = importLedger(args.ledger);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, records.map((r) => stableStringifyLine(r)).join(''));

  const summary = { n: records.length, tallies };
  io.log(args.json ? JSON.stringify(summary) : `captured ${records.length} calls; skipped mock=${tallies.skippedMock} error=${tallies.skippedError}`);
  return 0;
}

async function cmdAnalyze(rawArgs: string[], io: CliIO, dataDir: string, policy: Protocol): Promise<number> {
  const parsed = parseOrUsage(rawArgs, {
    traffic: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  if ('usageError' in parsed) {
    io.err(parsed.usageError);
    return 2;
  }
  const { args } = parsed;

  const trafficDir = args.traffic || resolve(dataDir, 'traffic');
  const { runMeta } = analyzeReport(dataDir, policy, { protocolCommit: null, extractedAt: null }, trafficDir);

  io.log(args.json ? JSON.stringify(runMeta) : `n=${runMeta.n} sessions=${runMeta.sessions} billed=$${runMeta.billedUsd.toFixed(4)} noCache=$${runMeta.noCacheUsd.toFixed(4)}`);
  return runMeta.n > 0 ? 0 : 1;
}

function cmdHeadline(rawArgs: string[], io: CliIO, dataDir: string, policy: Protocol): number {
  const parsed = parseOrUsage(rawArgs, { json: { type: 'boolean', default: false } });
  if ('usageError' in parsed) {
    io.err(parsed.usageError);
    return 2;
  }
  const { args } = parsed;

  const metaPath = resolve(dataDir, 'run-meta.json');
  if (!existsSync(metaPath)) {
    io.err('no run-meta.json yet; run `analyze` first');
    if (args.json) io.log(JSON.stringify({ error: 'no-run' }));
    return 1;
  }
  const runMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta;
  try {
    const sentence = renderReportHeadline(policy, runMeta);
    io.log(args.json ? JSON.stringify({ headline: sentence }) : sentence);
    return 0;
  } catch (err) {
    io.err(usageOf(err));
    if (args.json) io.log(JSON.stringify({ error: 'not-measured' }));
    return 1;
  }
}

function cmdRepro(rawArgs: string[], io: CliIO, dataDir: string, policy: Protocol): number {
  const parsed = parseOrUsage(rawArgs, { json: { type: 'boolean', default: false } });
  if ('usageError' in parsed) {
    io.err(parsed.usageError);
    return 2;
  }
  const { args } = parsed;

  const findingsPath = resolve(dataDir, 'findings.json');
  const metaPath = resolve(dataDir, 'run-meta.json');
  if (!existsSync(findingsPath) || !existsSync(metaPath)) {
    io.err('no committed findings.json/run-meta.json to reproduce; run `analyze` first');
    return 1;
  }

  const committedMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta;
  const tmp = mkdtempSync(resolve(tmpdir(), 'lca-repro-'));
  try {
    analyzeReport(tmp, policy, { protocolCommit: committedMeta.protocolCommit, extractedAt: committedMeta.extractedAt }, resolve(dataDir, 'traffic'));
    const strip = (s: string) => s.replace(/"generatedAt": "[^"]*"/, '"generatedAt": "<ignored>"');
    const same =
      strip(readFileSync(findingsPath, 'utf8')) === strip(readFileSync(resolve(tmp, 'findings.json'), 'utf8')) &&
      strip(readFileSync(metaPath, 'utf8')) === strip(readFileSync(resolve(tmp, 'run-meta.json'), 'utf8'));
    io.log(args.json ? JSON.stringify({ ok: same }) : same ? 'repro OK: findings.json and run-meta.json re-derived bit-for-bit' : 'repro FAILED: recomputed output differs from committed files');
    return same ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function cmdEstimate(rawArgs: string[], io: CliIO): number {
  const parsed = parseOrUsage(rawArgs, {
    plan: { type: 'string', required: true },
    json: { type: 'boolean', default: false },
  });
  if ('usageError' in parsed) {
    io.err(parsed.usageError);
    return 2;
  }
  const { args } = parsed;

  let text: string;
  try {
    text = readFileSync(args.plan, 'utf8');
  } catch (err) {
    io.err(`cannot read plan file: ${usageOf(err)}`);
    return 1;
  }
  const calls: PlannedCall[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    calls.push(JSON.parse(t) as PlannedCall);
  }
  const result = estimateStep(calls);
  io.log(args.json ? JSON.stringify(result) : `ceiling=$${result.ceilingUsd.toFixed(4)} perModel=${JSON.stringify(result.perModel)}`);
  return 0;
}

function cmdBudget(rawArgs: string[], io: CliIO): number {
  const parsed = parseOrUsage(rawArgs, {
    cap: { type: 'string', required: true },
    ledger: { type: 'string', required: true },
    json: { type: 'boolean', default: false },
  });
  if ('usageError' in parsed) {
    io.err(parsed.usageError);
    return 2;
  }
  const { args } = parsed;

  const capUsd = Number(args.cap);
  const ledger = new Ledger(args.ledger);
  try {
    const status = new BudgetGuard(capUsd, ledger).status();
    io.log(args.json ? JSON.stringify(status) : `spent=$${status.spent.toFixed(4)} cap=$${status.cap.toFixed(2)} level=${status.level}`);
    return status.level === 'stop' ? 1 : 0;
  } finally {
    ledger.close();
  }
}

function cmdReport(rawArgs: string[], io: CliIO, dataDir: string): number {
  const parsed = parseOrUsage(rawArgs, {
    format: { type: 'string', default: 'table' },
    json: { type: 'boolean', default: false },
  });
  if ('usageError' in parsed) {
    io.err(parsed.usageError);
    return 2;
  }
  const { args } = parsed;

  const findingsPath = resolve(dataDir, 'findings.json');
  const metaPath = resolve(dataDir, 'run-meta.json');
  if (!existsSync(findingsPath) || !existsSync(metaPath)) {
    io.err('no run yet; run `analyze` first');
    return 1;
  }
  const findings = JSON.parse(readFileSync(findingsPath, 'utf8')) as CallFinding[];
  const runMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta;
  const format: ReportFormat = args.json ? 'json' : ((args.format as ReportFormat) ?? 'table');
  io.log(renderReport(findings, runMeta, format).trimEnd());
  return 0;
}

/** Runs one CLI invocation and returns its exit code (never calls process.exit itself). */
export async function runCli(argv: string[], io: CliIO = defaultIo, dataDir: string = DATA_DIR): Promise<number> {
  const [cmd, ...rest] = argv;
  const policy = loadPolicy();
  switch (cmd) {
    case 'extract':
      return cmdExtract(rest, io, dataDir);
    case 'capture':
      return cmdCapture(rest, io);
    case 'analyze':
      return cmdAnalyze(rest, io, dataDir, policy);
    case 'headline':
      return cmdHeadline(rest, io, dataDir, policy);
    case 'repro':
      return cmdRepro(rest, io, dataDir, policy);
    case 'estimate':
      return cmdEstimate(rest, io);
    case 'budget':
      return cmdBudget(rest, io);
    case 'report':
      return cmdReport(rest, io, dataDir);
    default:
      io.err(`unknown command: ${cmd ?? '(none)'}\ncommands: ${COMMANDS.join(' | ')}`);
      return 2;
  }
}

// Only run as a process when invoked directly (not when imported by tests).
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
