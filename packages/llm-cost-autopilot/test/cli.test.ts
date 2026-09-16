import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger, stableStringifyLine, type TrafficRecord } from '@portfolio-builds/shared';
import { runCli, type CliIO } from '../src/cli';

function capturingIo(): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, log: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

function trafficRec(id: string): TrafficRecord {
  return {
    v: 1,
    id,
    ts: '2026-08-20T10:00:00.000Z',
    source: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    purpose: null,
    runId: null,
    tenant: null,
    tags: {},
    latencyTolerant: false,
    session: 's1',
    sidechain: false,
    systemSha256: null,
    systemChars: null,
    userSha256: null,
    userChars: null,
    usage: { input: 100, cacheRead: 20, cacheCreation5m: 0, cacheCreation1h: 0, output: 40 },
    mock: false,
    error: null,
    cache: null,
  };
}

function makeDataDirWithRun(): string {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'lca-cli-'));
  const trafficDir = resolve(dataDir, 'traffic');
  mkdirSync(trafficDir, { recursive: true });
  writeFileSync(resolve(trafficDir, 'a.jsonl'), stableStringifyLine(trafficRec('c1')));
  return dataDir;
}

describe('cli: dispatch and exit codes', () => {
  it('unknown command exits 2', async () => {
    const io = capturingIo();
    const code = await runCli(['bogus-command'], io, mkdtempSync(resolve(tmpdir(), 'lca-cli-')));
    expect(code).toBe(2);
  });

  it('no command at all exits 2', async () => {
    const io = capturingIo();
    const code = await runCli([], io, mkdtempSync(resolve(tmpdir(), 'lca-cli-')));
    expect(code).toBe(2);
  });

  it('headline without a run exits 1', async () => {
    const io = capturingIo();
    const dataDir = mkdtempSync(resolve(tmpdir(), 'lca-cli-'));
    const code = await runCli(['headline'], io, dataDir);
    expect(code).toBe(1);
  });
});

describe('cli: analyze -> headline -> report roundtrip', () => {
  it('runs analyze then headline then report --json, and every --json output parses', async () => {
    const dataDir = makeDataDirWithRun();
    const io = capturingIo();

    const analyzeCode = await runCli(['analyze', '--json'], io, dataDir);
    expect(analyzeCode).toBe(0);
    const analyzeOut = JSON.parse(io.stdout.at(-1)!);
    expect(analyzeOut.n).toBe(1);

    const headlineCode = await runCli(['headline', '--json'], io, dataDir);
    expect(headlineCode).toBe(0);
    const headlineOut = JSON.parse(io.stdout.at(-1)!);
    expect(typeof headlineOut.headline).toBe('string');
    expect(headlineOut.headline).toContain('Across');

    const reportCode = await runCli(['report', '--format', 'json'], io, dataDir);
    expect(reportCode).toBe(0);
    const reportOut = JSON.parse(io.stdout.at(-1)!);
    expect(reportOut.runMeta.n).toBe(1);
    expect(reportOut.findings.length).toBe(1);
  });

  it('analyze on an empty traffic dir exits 1 (no-run)', async () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), 'lca-cli-'));
    mkdirSync(resolve(dataDir, 'traffic'), { recursive: true });
    const io = capturingIo();
    const code = await runCli(['analyze'], io, dataDir);
    expect(code).toBe(1);
  });

  it('report before any analyze exits 1', async () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), 'lca-cli-'));
    const io = capturingIo();
    const code = await runCli(['report'], io, dataDir);
    expect(code).toBe(1);
  });

  it('repro matches the committed output after analyze', async () => {
    const dataDir = makeDataDirWithRun();
    const io = capturingIo();
    expect(await runCli(['analyze'], io, dataDir)).toBe(0);
    const reproCode = await runCli(['repro'], io, dataDir);
    expect(reproCode).toBe(0);
  });
});

describe('cli: extract refuses without PB_ANON_SALT', () => {
  const savedSalt = process.env.PB_ANON_SALT;
  beforeEach(() => {
    delete process.env.PB_ANON_SALT;
  });
  afterEach(() => {
    if (savedSalt !== undefined) process.env.PB_ANON_SALT = savedSalt;
  });

  it('exits 1 with no salt set', async () => {
    const io = capturingIo();
    const dataDir = mkdtempSync(resolve(tmpdir(), 'lca-cli-'));
    const code = await runCli(['extract', '--root', '/nonexistent', '--from', '2026-08-16', '--to', '2026-09-15'], io, dataDir);
    expect(code).toBe(1);
  });
});

describe('cli: estimate', () => {
  it('reads a JSONL plan and exits 0 with a ceiling', async () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), 'lca-cli-'));
    const planPath = resolve(dataDir, 'plan.jsonl');
    writeFileSync(planPath, JSON.stringify({ model: 'claude-haiku-4-5', inputChars: 3000, maxOutputTokens: 500 }) + '\n');
    const io = capturingIo();
    const code = await runCli(['estimate', '--plan', planPath, '--json'], io, dataDir);
    expect(code).toBe(0);
    const out = JSON.parse(io.stdout.at(-1)!);
    expect(out.ceilingUsd).toBeGreaterThan(0);
  });

  it('missing --plan is a usage error, exit 2', async () => {
    const io = capturingIo();
    const code = await runCli(['estimate'], io, mkdtempSync(resolve(tmpdir(), 'lca-cli-')));
    expect(code).toBe(2);
  });
});

describe('cli: budget', () => {
  it('exits 1 (stop) once spend reaches the cap', async () => {
    const dbPath = resolve(mkdtempSync(resolve(tmpdir(), 'lca-cli-')), 'ledger.db');
    const ledger = new Ledger(dbPath);
    ledger.insert({ provider: 'anthropic', model: 'claude-haiku-4-5', costUsd: 1, mock: false });
    ledger.close();
    const io = capturingIo();
    const code = await runCli(['budget', '--cap', '1', '--ledger', dbPath, '--json'], io, mkdtempSync(resolve(tmpdir(), 'lca-cli-')));
    expect(code).toBe(1);
    const out = JSON.parse(io.stdout.at(-1)!);
    expect(out.level).toBe('stop');
  });

  it('exits 0 (ok) below the warn threshold', async () => {
    const dbPath = resolve(mkdtempSync(resolve(tmpdir(), 'lca-cli-')), 'ledger.db');
    const ledger = new Ledger(dbPath);
    ledger.insert({ provider: 'anthropic', model: 'claude-haiku-4-5', costUsd: 0.01, mock: false });
    ledger.close();
    const io = capturingIo();
    const code = await runCli(['budget', '--cap', '10', '--ledger', dbPath], io, mkdtempSync(resolve(tmpdir(), 'lca-cli-')));
    expect(code).toBe(0);
  });
});

describe('cli: capture', () => {
  it('imports non-mock, non-error ledger rows to a jsonl file', async () => {
    const workDir = mkdtempSync(resolve(tmpdir(), 'lca-cli-'));
    const dbPath = resolve(workDir, 'ledger.db');
    const outPath = resolve(workDir, 'captured.jsonl');
    const ledger = new Ledger(dbPath);
    ledger.insert({ provider: 'anthropic', model: 'claude-sonnet-5', usage: { input: 10, output: 5 }, costUsd: 0.001, mock: false });
    ledger.insert({ provider: 'anthropic', model: 'claude-sonnet-5', usage: { input: 10, output: 5 }, costUsd: 0, mock: true });
    ledger.close();
    const io = capturingIo();
    const code = await runCli(['capture', '--ledger', dbPath, '--out', outPath, '--json'], io, workDir);
    expect(code).toBe(0);
    const out = JSON.parse(io.stdout.at(-1)!);
    expect(out.n).toBe(1);
    expect(out.tallies.skippedMock).toBe(1);
  });
});
