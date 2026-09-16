import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { renderHeadline } from '@portfolio-builds/shared';
import { piiSweep, readmeHeadlineAudit } from '../src/audits';
import { loadProtocol } from '../src/protocol';
import { compare } from '../src/compare';
import { buildRunMeta } from '../src/report';
import type { ConditionRun, ItemResult } from '../src/runner';

const proto = loadProtocol();

function mkRun(name: string, model: string, passExact: boolean[]): ConditionRun {
  const results: ItemResult[] = passExact.map((p, i) => ({
    index: i, id: `WO-${1000 + i}`, model, content: '{}', error: null, costUsd: 0.001,
    latencyMs: 1, usage: null, mock: true, passParse: true, passExact: p, skipped: null, at: '2026-09-15T00:00:00.000Z',
  }));
  const k = passExact.filter(Boolean).length;
  return { name, model, maxTokens: 400, n: passExact.length, completed: passExact.length, k, kParse: passExact.length, skipped: 0, errors: 0, totalCostUsd: 0.001 * passExact.length, results };
}
const vec = (t: number, n = 40) => Array.from({ length: n }, (_, i) => i < t);

describe('piiSweep', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(resolve(tmpdir(), 'mr-pii-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes a clean tree and flags a file containing PII', () => {
    mkdirSync(resolve(dir, 'data'), { recursive: true });
    writeFileSync(resolve(dir, 'data', 'clean.json'), JSON.stringify({ id: 'WO-1234', total_cents: 500 }));
    expect(piiSweep([dir]).ok).toBe(true);

    writeFileSync(resolve(dir, 'data', 'leak.json'), JSON.stringify({ note: 'contact me at jane.doe@example.com' }));
    const res = piiSweep([dir]);
    expect(res.ok).toBe(false);
    expect(res.violations[0]!.hits[0]!.kind).toBe('email');
  });
});

describe('readmeHeadlineAudit', () => {
  const a = mkRun('A', 'claude-sonnet-5', vec(38));
  const b = mkRun('B', 'claude-haiku-4-5', vec(30));
  const noise = mkRun('A-repeat', 'claude-sonnet-5', vec(38));
  const meta = buildRunMeta(proto, compare(a, b, noise), {
    runDate: '2026-09-15', ledgerTotalUsd: 0.26, ledgerCalls: 120, protocolCommit: 'abc', frozenAt: '2026-09-15T00:00:00.000Z', ranAt: '2026-09-15T01:00:00.000Z', generatedAt: 'x',
  });

  it('passes when the README contains the run-meta-rendered headline verbatim', () => {
    const rendered = renderHeadline(proto.experiment.headline_template, meta.headlineValues!);
    const readme = `# model-regress\n\n${rendered}\n\nMore text.`;
    expect(readmeHeadlineAudit(readme, proto, meta).ok).toBe(true);
  });

  it('fails when the README headline was altered (a hand-typed number)', () => {
    const rendered = renderHeadline(proto.experiment.headline_template, meta.headlineValues!);
    const tampered = rendered.replace('38/40', '40/40');
    const readme = `# model-regress\n\n${tampered}\n`;
    expect(readmeHeadlineAudit(readme, proto, meta).ok).toBe(false);
  });

  it('is vacuously ok before a paired run produces headline values', () => {
    const empty = mkRun('A', 'claude-sonnet-5', []);
    const emptyMeta = buildRunMeta(proto, compare(empty, mkRun('B', 'claude-haiku-4-5', [])), { runDate: '2026-09-15', ledgerTotalUsd: 0, ledgerCalls: 0, protocolCommit: null, frozenAt: null, ranAt: null, generatedAt: 'x' });
    expect(readmeHeadlineAudit('# no headline yet', proto, emptyMeta).ok).toBe(true);
  });
});
