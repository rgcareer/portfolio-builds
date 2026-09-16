// Orchestration: read committed traffic, price it, write the two canonical output files,
// and render the headline / a report in one of three formats. Every dollar in the headline
// comes from a committed run-meta.json via renderHeadline — nothing here hand-formats a
// number into the sentence.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHeadline, stableStringify, type HeadlineValue } from '@portfolio-builds/shared';
import { loadPolicy, DATA_DIR, type Protocol } from './protocol';
import { readTraffic } from './traffic';
import { analyzeTraffic, type CallFinding, type RunMeta, type AnalyzeOptions } from './counterfactual';

export interface AnalyzeResultFiles {
  findings: CallFinding[];
  runMeta: RunMeta;
}

/**
 * Reads every *.jsonl under `trafficDir` (default `<dataDir>/traffic`), prices it, and
 * writes `<dataDir>/findings.json` + `<dataDir>/run-meta.json` in canonical form. Returns
 * what it wrote so a caller (the CLI, or repro) can act on it without re-reading the files.
 */
export function analyze(
  dataDir: string = DATA_DIR,
  policy: Protocol = loadPolicy(),
  opts: AnalyzeOptions = { protocolCommit: null, extractedAt: null },
  trafficDir: string = resolve(dataDir, 'traffic'),
): AnalyzeResultFiles {
  const records = readTraffic(trafficDir);
  const { findings, runMeta } = analyzeTraffic(records, policy, opts);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, 'findings.json'), stableStringify(findings));
  writeFileSync(resolve(dataDir, 'run-meta.json'), stableStringify(runMeta));
  return { findings, runMeta };
}

/** The exact placeholder map the headline template needs — null fields when pct is null. */
export function buildHeadlineValues(runMeta: RunMeta): Record<string, HeadlineValue | null> {
  return {
    n: runMeta.n,
    sessions: runMeta.sessions,
    from: runMeta.from,
    to: runMeta.to,
    nocache: runMeta.noCacheUsd.toFixed(2),
    billed: runMeta.billedUsd.toFixed(2),
    savedPct: runMeta.pct?.savedPct ?? null,
    lo: runMeta.pct?.lo ?? null,
    hi: runMeta.pct?.hi ?? null,
    kRead: runMeta.kRead,
    pRead: runMeta.pct?.pRead ?? null,
    loR: runMeta.pct?.loR ?? null,
    hiR: runMeta.pct?.hiR ?? null,
  };
}

/** Renders policy.headline_template against runMeta. Throws (HeadlineError) when pct is null. */
export function renderReportHeadline(policy: Protocol, runMeta: RunMeta): string {
  return renderHeadline(policy.rules.headline_template, buildHeadlineValues(runMeta));
}

export type ReportFormat = 'table' | 'json' | 'md';

export function report(findings: readonly CallFinding[], runMeta: RunMeta, format: ReportFormat): string {
  if (format === 'json') return stableStringify({ runMeta, findings });

  const mechLines =
    format === 'md'
      ? ['', '## Mechanisms', '', '| mechanism | usd |', '|---|---|', `| cache | ${runMeta.mechanisms.cacheUsd.toFixed(4)} |`, `| batch | ${runMeta.mechanisms.batchUsd.toFixed(4)} |`, `| routing (unverified) | ${runMeta.mechanisms.routingUsd.toFixed(4)} |`]
      : [`mechanisms: cache=$${runMeta.mechanisms.cacheUsd.toFixed(4)} batch=$${runMeta.mechanisms.batchUsd.toFixed(4)} routing(unverified)=$${runMeta.mechanisms.routingUsd.toFixed(4)}`];

  if (format === 'md') {
    return (
      ['# LLM Cost Autopilot Report', '', `- n: ${runMeta.n}`, `- sessions: ${runMeta.sessions}`, `- window: ${runMeta.from} to ${runMeta.to}`, `- billed: $${runMeta.billedUsd.toFixed(4)}`, `- no-cache: $${runMeta.noCacheUsd.toFixed(4)}`, `- saved: $${runMeta.savedUsd.toFixed(4)}`, `- cache reads: ${runMeta.kRead}/${runMeta.n}`, ...mechLines].join(
        '\n',
      ) + '\n'
    );
  }

  return (
    [
      `n=${runMeta.n} sessions=${runMeta.sessions} window=${runMeta.from}..${runMeta.to}`,
      `billed=$${runMeta.billedUsd.toFixed(4)} noCache=$${runMeta.noCacheUsd.toFixed(4)} saved=$${runMeta.savedUsd.toFixed(4)}`,
      `cacheReads=${runMeta.kRead}/${runMeta.n}`,
      ...mechLines,
    ].join('\n') + '\n'
  );
}
