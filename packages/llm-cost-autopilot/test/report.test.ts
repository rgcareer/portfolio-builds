import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stableStringifyLine, HeadlineError, type TrafficRecord } from '@portfolio-builds/shared';
import { loadPolicy } from '../src/protocol';
import { analyze, buildHeadlineValues, renderReportHeadline, report } from '../src/report';

const policy = loadPolicy();

function trafficRec(id: string, usage: TrafficRecord['usage']): TrafficRecord {
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
    usage,
    mock: false,
    error: null,
    cache: null,
  };
}

function makeTrafficDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'lca-report-'));
  const trafficDir = resolve(dir, 'traffic');
  mkdirSync(trafficDir, { recursive: true });
  writeFileSync(
    resolve(trafficDir, 'a.jsonl'),
    stableStringifyLine(trafficRec('a1', { input: 100, cacheRead: 20, cacheCreation5m: 0, cacheCreation1h: 0, output: 50 })) +
      stableStringifyLine(trafficRec('a2', { input: 200, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 60 })),
  );
  return dir;
}

describe('report: analyze() orchestration', () => {
  it('writes findings.json and run-meta.json that are deterministic except generatedAt', () => {
    const trafficDir = makeTrafficDir();
    try {
      const outA = resolve(trafficDir, 'out-a');
      const outB = resolve(trafficDir, 'out-b');
      mkdirSync(outA, { recursive: true });
      mkdirSync(outB, { recursive: true });
      // Both outputs read the SAME committed traffic dir (under trafficDir/traffic).
      analyze(outA, policy, { protocolCommit: 'deadbeef', extractedAt: '2026-09-15T00:00:00.000Z' }, resolve(trafficDir, 'traffic'));
      analyze(outB, policy, { protocolCommit: 'deadbeef', extractedAt: '2026-09-15T00:00:00.000Z' }, resolve(trafficDir, 'traffic'));

      const strip = (s: string) => s.replace(/"generatedAt": "[^"]*"/, '"generatedAt": "<ignored>"');
      const findingsA = strip(readFileSync(resolve(outA, 'findings.json'), 'utf8'));
      const findingsB = strip(readFileSync(resolve(outB, 'findings.json'), 'utf8'));
      const metaA = strip(readFileSync(resolve(outA, 'run-meta.json'), 'utf8'));
      const metaB = strip(readFileSync(resolve(outB, 'run-meta.json'), 'utf8'));
      expect(findingsA).toBe(findingsB);
      expect(metaA).toBe(metaB);
      expect(metaA).toContain('<ignored>'); // sanity: strip actually matched something
    } finally {
      rmSync(trafficDir, { recursive: true, force: true });
    }
  });

  it('returns findings and runMeta with n matching the traffic fixture', () => {
    const trafficDir = makeTrafficDir();
    try {
      const out = resolve(trafficDir, 'out');
      mkdirSync(out, { recursive: true });
      const { findings, runMeta } = analyze(out, policy, { protocolCommit: null, extractedAt: null }, resolve(trafficDir, 'traffic'));
      expect(findings.length).toBe(2);
      expect(runMeta.n).toBe(2);
      expect(existsSync(resolve(out, 'findings.json'))).toBe(true);
      expect(existsSync(resolve(out, 'run-meta.json'))).toBe(true);
    } finally {
      rmSync(trafficDir, { recursive: true, force: true });
    }
  });
});

describe('report: buildHeadlineValues', () => {
  it('maps every headline placeholder to a value', () => {
    const trafficDir = makeTrafficDir();
    try {
      const out = resolve(trafficDir, 'out');
      mkdirSync(out, { recursive: true });
      const { runMeta } = analyze(out, policy, { protocolCommit: null, extractedAt: null }, resolve(trafficDir, 'traffic'));
      const values = buildHeadlineValues(runMeta);
      for (const key of ['n', 'sessions', 'from', 'to', 'nocache', 'billed', 'savedPct', 'lo', 'hi', 'kRead', 'pRead', 'loR', 'hiR']) {
        expect(Object.prototype.hasOwnProperty.call(values, key)).toBe(true);
      }
    } finally {
      rmSync(trafficDir, { recursive: true, force: true });
    }
  });
});

describe('report: headline refuses without pct', () => {
  it('renderReportHeadline throws HeadlineError when run-meta has no data (pct null)', () => {
    const trafficDir = mkdtempSync(resolve(tmpdir(), 'lca-report-empty-'));
    try {
      const emptyTraffic = resolve(trafficDir, 'traffic');
      mkdirSync(emptyTraffic, { recursive: true }); // no *.jsonl files at all -> n = 0
      const out = resolve(trafficDir, 'out');
      mkdirSync(out, { recursive: true });
      const { runMeta } = analyze(out, policy, { protocolCommit: null, extractedAt: null }, emptyTraffic);
      expect(runMeta.pct).toBeNull();
      expect(() => renderReportHeadline(policy, runMeta)).toThrow(HeadlineError);
    } finally {
      rmSync(trafficDir, { recursive: true, force: true });
    }
  });
});

describe('report: report(format)', () => {
  it('json format round-trips through JSON.parse', () => {
    const trafficDir = makeTrafficDir();
    try {
      const out = resolve(trafficDir, 'out');
      mkdirSync(out, { recursive: true });
      const { findings, runMeta } = analyze(out, policy, { protocolCommit: null, extractedAt: null }, resolve(trafficDir, 'traffic'));
      const s = report(findings, runMeta, 'json');
      const parsed = JSON.parse(s);
      expect(parsed.runMeta.n).toBe(2);
      expect(parsed.findings.length).toBe(2);
    } finally {
      rmSync(trafficDir, { recursive: true, force: true });
    }
  });

  it('table and md formats render non-empty text containing the totals', () => {
    const trafficDir = makeTrafficDir();
    try {
      const out = resolve(trafficDir, 'out');
      mkdirSync(out, { recursive: true });
      const { findings, runMeta } = analyze(out, policy, { protocolCommit: null, extractedAt: null }, resolve(trafficDir, 'traffic'));
      const table = report(findings, runMeta, 'table');
      const md = report(findings, runMeta, 'md');
      expect(table).toContain(String(runMeta.n));
      expect(md).toContain('mechanism');
    } finally {
      rmSync(trafficDir, { recursive: true, force: true });
    }
  });
});
