#!/usr/bin/env node
// agent-forensics CLI (citty). Commands: ingest · analyze · headline · repro · report ·
// detect · convert · audit · show. Exit codes: 0 ok, 1 domain signal/failure, 2 usage error.
// $0 — no network, no LLM call, no real spend anywhere.

import { defineCommand, runCommand, type CommandDef } from 'citty';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { requireSalt, stableStringify } from '@portfolio-builds/shared';
import { loadProtocol, DATA_DIR, FIXTURES_DIR, type Protocol } from './protocol';
import { ingestClaudeCodeDir, parseTranscript } from './adapters/claudeCode';
import { fromAgentTraceFile } from './adapters/agentTrace';
import { runDetectors, hasHeadlineSignature } from './detectors';
import { analyzeRecords, readRecords, writeAnalysis, headlineFromRunMeta, type RunMeta } from './analyze';
import { report, renderReportText } from './report';
import { auditTree } from './audit';
import { reproduce } from './repro';

export interface CliCtx {
  env: NodeJS.ProcessEnv;
  cwd: string;
  protocol: Protocol;
  out: (s: string) => void;
  err: (s: string) => void;
}

function ctxOf(data: unknown): CliCtx {
  return data as CliCtx;
}

const ingest = defineCommand({
  meta: { name: 'ingest', description: 'Redact Claude Code transcripts under --dir into RunRecords (refuses without PB_ANON_SALT).' },
  args: {
    dir: { type: 'string', description: 'directory of *.jsonl transcripts', required: true },
    out: { type: 'string', description: 'output records dir', default: 'data/records' },
  },
  run({ args, data }) {
    const c = ctxOf(data);
    let salt: string;
    try {
      salt = requireSalt(c.env);
    } catch (e) {
      c.err(`ingest refused: ${(e as Error).message}`);
      return 1;
    }
    const dir = resolve(c.cwd, args.dir);
    const recordsDir = resolve(c.cwd, args.out);
    const dataDir = dirname(recordsDir);
    mkdirSync(recordsDir, { recursive: true });
    const result = ingestClaudeCodeDir(dir, {
      salt,
      protocol: c.protocol,
      onFile: (name, record) => {
        writeFileSync(resolve(recordsDir, `${record.runId}.json`), stableStringify(record));
        c.err(`  ${name} -> ${record.runId} (${record.meta['llmTurns']} llm turns, ${record.toolCalls.length} tool calls)`);
      },
    });
    const ingestedAt = new Date().toISOString();
    writeFileSync(resolve(dataDir, 'run-state.json'), stableStringify({ protocolHash: c.protocol.hash, protocolCommit: null, ingestedAt }));
    writeFileSync(
      resolve(dataDir, 'ingest-ledger.json'),
      stableStringify({
        protocolHash: c.protocol.hash,
        ingestedAt,
        totalFiles: result.totalFiles,
        excludedZeroAssistant: result.excludedZeroAssistant,
        records: result.records.map((r) => ({ runId: r.runId, llmTurns: Number(r.meta['llmTurns'] ?? 0), toolCalls: r.toolCalls.length })).sort((a, b) => a.runId.localeCompare(b.runId)),
      }),
    );
    c.out(`ingested ${result.records.length} sessions (${result.excludedZeroAssistant} zero-assistant files excluded of ${result.totalFiles})`);
    return 0;
  },
});

const analyze = defineCommand({
  meta: { name: 'analyze', description: 'Derive findings.json + run-meta.json from data/records.' },
  run({ data }) {
    const c = ctxOf(data);
    const dataDir = resolve(c.cwd, 'data');
    const records = readRecords(resolve(dataDir, 'records'));
    if (records.length === 0) {
      c.err('analyze: no records under data/records — run ingest first');
      return 1;
    }
    const statePath = resolve(dataDir, 'run-state.json');
    const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { protocolCommit: string | null; ingestedAt: string | null }) : { protocolCommit: null, ingestedAt: null };
    const ledgerPath = resolve(dataDir, 'ingest-ledger.json');
    const ledger = existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { totalFiles?: number; excludedZeroAssistant?: number }) : null;
    const { findings, runMeta } = analyzeRecords(records, c.protocol, {
      protocolCommit: state.protocolCommit,
      ingestedAt: state.ingestedAt,
      totalFiles: ledger?.totalFiles ?? records.length,
      excludedZeroAssistant: ledger?.excludedZeroAssistant ?? 0,
    });
    writeAnalysis(dataDir, findings, runMeta);
    c.out(`analyzed ${runMeta.sessions} sessions; k=${runMeta.k} (${runMeta.pct.p}%); top ${runMeta.topClass} (${runMeta.topK}); ${runMeta.errCalls}/${runMeta.toolCalls} error calls`);
    return 0;
  },
});

const headline = defineCommand({
  meta: { name: 'headline', description: 'Render the headline sentence from run-meta.json.' },
  run({ data }) {
    const c = ctxOf(data);
    const metaPath = resolve(c.cwd, 'data', 'run-meta.json');
    if (!existsSync(metaPath)) {
      c.err('headline: no data/run-meta.json — run analyze first');
      return 1;
    }
    const runMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta;
    c.out(headlineFromRunMeta(runMeta, c.protocol));
    return 0;
  },
});

const repro = defineCommand({
  meta: { name: 'repro', description: 'Re-derive findings.json + run-meta.json from committed records, offline, bit-for-bit.' },
  run({ data }) {
    const c = ctxOf(data);
    const dataDir = resolve(c.cwd, 'data');
    if (!existsSync(resolve(dataDir, 'run-meta.json'))) {
      c.err('repro: no committed run-meta.json yet — nothing to reproduce (run ingest + analyze first)');
      return 1;
    }
    const r = reproduce(dataDir, c.protocol);
    c.out(r.ok ? `repro OK: findings.json and run-meta.json re-derived bit-for-bit (${r.sessions} sessions)` : `repro FAILED: ${r.diff}`);
    return r.ok ? 0 : 1;
  },
});

const reportCmd = defineCommand({
  meta: { name: 'report', description: 'Print a post-mortem report for one record.' },
  args: { record: { type: 'positional', description: 'path to a record JSON' }, json: { type: 'boolean', default: false } },
  run({ args, data }) {
    const c = ctxOf(data);
    if (!args.record) {
      c.err('report: a record path is required');
      return 2;
    }
    const path = resolve(c.cwd, args.record);
    if (!existsSync(path)) {
      c.err(`report: no such file ${args.record}`);
      return 1;
    }
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const r = report(record, c.protocol);
    c.out(args.json ? stableStringify(r).trimEnd() : renderReportText(r));
    return 0;
  },
});

const detect = defineCommand({
  meta: { name: 'detect', description: 'Detect signatures in one record; exit 1 if any headline-set signature is present.' },
  args: { record: { type: 'positional', description: 'path to a record JSON' }, json: { type: 'boolean', default: false } },
  run({ args, data }) {
    const c = ctxOf(data);
    if (!args.record) {
      c.err('detect: a record path is required');
      return 2;
    }
    const path = resolve(c.cwd, args.record);
    if (!existsSync(path)) {
      c.err(`detect: no such file ${args.record}`);
      return 1;
    }
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const sigs = runDetectors(record, c.protocol);
    c.out(args.json ? stableStringify(sigs).trimEnd() : sigs.map((s) => `${s.detector} [${s.severity}] turns ${s.turnStart}-${s.turnEnd}`).join('\n') || '(no signatures)');
    return hasHeadlineSignature(sigs, c.protocol) ? 1 : 0;
  },
});

const convert = defineCommand({
  meta: { name: 'convert', description: 'Convert an agent-trace or claude-code file to a RunRecord.' },
  args: {
    from: { type: 'string', description: 'agent-trace | claude-code', required: true },
    file: { type: 'positional', description: 'path to the source file' },
    json: { type: 'boolean', default: false },
  },
  run({ args, data }) {
    const c = ctxOf(data);
    if (!args.file) {
      c.err('convert: a file path is required');
      return 2;
    }
    const path = resolve(c.cwd, args.file);
    if (!existsSync(path)) {
      c.err(`convert: no such file ${args.file}`);
      return 1;
    }
    let record;
    if (args.from === 'agent-trace') {
      record = fromAgentTraceFile(path);
    } else if (args.from === 'claude-code') {
      let salt: string;
      try {
        salt = requireSalt(c.env);
      } catch (e) {
        c.err(`convert --from claude-code refused: ${(e as Error).message}`);
        return 1;
      }
      record = parseTranscript(readFileSync(path, 'utf8'), { salt, protocol: c.protocol });
    } else {
      c.err(`convert: unknown --from ${args.from} (use agent-trace | claude-code)`);
      return 2;
    }
    const s = stableStringify(record).trimEnd();
    c.out(s);
    return 0;
  },
});

const audit = defineCommand({
  meta: { name: 'audit', description: 'Sweep committed data/ + fixtures/ for redaction violations; exit 1 on any.' },
  args: { dir: { type: 'positional', description: 'directory to audit (default: data + fixtures)' } },
  run({ args, data }) {
    const c = ctxOf(data);
    const dirs = args.dir ? [resolve(c.cwd, args.dir)] : [DATA_DIR, FIXTURES_DIR];
    const res = auditTree(dirs, c.protocol, c.cwd);
    if (res.violations.length > 0) {
      c.err(`audit: FAIL (${res.violations.length} violations across ${res.filesScanned} files)`);
      for (const v of res.violations.slice(0, 25)) c.err(`  ${v.file} ${v.path} [${v.kind}] ${v.detail}`);
      return 1;
    }
    c.out(`audit: OK — ${res.filesScanned} committed JSON files under data/ + fixtures/ are clean`);
    return 0;
  },
});

const show = defineCommand({
  meta: { name: 'show', description: 'LOCAL-ONLY human view of a raw transcript (verbatim; never committed). --raw <file> --turns a-b' },
  args: {
    raw: { type: 'string', description: 'raw session.jsonl (local, unredacted)', required: true },
    turns: { type: 'string', description: 'range a-b (record indices)', default: '' },
  },
  run({ args, data }) {
    const c = ctxOf(data);
    const path = resolve(c.cwd, args.raw);
    if (!existsSync(path)) {
      c.err(`show: no such file ${args.raw}`);
      return 1;
    }
    const recs = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let a = 0;
    let b = recs.length - 1;
    const m = /^(\d+)-(\d+)$/.exec(args.turns);
    if (m) {
      a = Math.max(0, Number(m[1]));
      b = Math.min(recs.length - 1, Number(m[2]));
    }
    c.err('show: LOCAL human view only — verbatim, never commit this output.');
    for (let i = a; i <= b; i++) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(recs[i]!);
      } catch {
        c.out(`[${i}] <malformed line>`);
        continue;
      }
      const type = String(obj['type'] ?? '?');
      const msg = obj['message'] as { content?: unknown } | undefined;
      let preview = '';
      if (typeof msg?.content === 'string') preview = msg.content.slice(0, 200);
      else if (Array.isArray(msg?.content)) preview = msg.content.map((x) => (x as { type?: string }).type).join('+');
      c.out(`[${i}] ${type}  ${preview}`);
    }
    return 0;
  },
});

// Manual dispatch: citty's runCommand runs a parent command's own `run` even after a
// subcommand fires (discarding the subcommand's result), so we route to each subcommand
// directly — citty still parses that subcommand's args and surfaces its numeric exit code.
const COMMANDS: Record<string, CommandDef<any>> = {
  ingest,
  analyze,
  headline,
  repro,
  report: reportCmd,
  detect,
  convert,
  audit,
  show,
};
const USAGE = 'commands: ingest | analyze | headline | repro | report | detect | convert | audit | show';

export interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  protocol?: Protocol;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** Testable entrypoint: returns the exit code instead of calling process.exit. */
export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<number> {
  const ctx: CliCtx = {
    env: opts.env ?? process.env,
    cwd: opts.cwd ?? process.cwd(),
    protocol: opts.protocol ?? loadProtocol(),
    out: opts.out ?? ((s) => process.stdout.write(s + '\n')),
    err: opts.err ?? ((s) => process.stderr.write(s + '\n')),
  };
  const name = argv[0];
  if (!name || !(name in COMMANDS)) {
    ctx.err(USAGE);
    return 2;
  }
  try {
    const { result } = await runCommand(COMMANDS[name]!, { rawArgs: argv.slice(1), data: ctx });
    return typeof result === 'number' ? result : 0;
  } catch (e) {
    ctx.err(`error: ${(e as Error).message}`);
    return 2;
  }
}

// Direct execution: run and translate the returned code into a process exit.
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
