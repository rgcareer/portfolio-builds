// Analysis is a pure function of the committed records and the frozen protocol. It produces
// findings.json (per-session detector results + blame) and run-meta.json (the disclosed
// denominators and Wilson intervals). The headline is rendered ONLY from run-meta via
// renderHeadline, so no number is ever hand-typed. Sessions are the sampling unit.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableStringify, wilsonPctStrings, parseRunRecord, renderHeadline, byteCompare } from '@portfolio-builds/shared';
import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol, DetectorName } from './protocol';
import { runDetectors, detectorSet, hasHeadlineSignature } from './detectors';
import { blameSpan } from './timeline';

export interface RecordFinding {
  runId: string;
  detectors: DetectorName[];
  hasHeadlineSignature: boolean;
  toolCalls: number;
  errCalls: number;
  signatureCount: number;
  blame: { detector: DetectorName; severity: string; turnStart: number; turnEnd: number } | null;
}

export interface Findings {
  piece: 'agent-forensics';
  protocolHash: string;
  records: RecordFinding[];
  byDetector: Record<string, number>;
  generatedAt: string;
}

export interface PctStrings {
  p: string;
  lo: string;
  hi: string;
  err_p: string;
  err_lo: string;
  err_hi: string;
}

export interface RunMeta {
  piece: 'agent-forensics';
  protocolHash: string;
  protocolCommit: string | null;
  ingestedAt: string | null;
  from: string;
  to: string;
  totalFiles: number;
  excludedZeroAssistant: number;
  sessions: number;
  k: number;
  toolCalls: number;
  errCalls: number;
  topClass: string;
  topK: number;
  byDetector: Record<string, number>;
  pct: PctStrings;
  generatedAt: string;
}

export interface AnalyzeMeta {
  protocolCommit?: string | null;
  ingestedAt?: string | null;
  totalFiles?: number;
  excludedZeroAssistant?: number;
  generatedAt?: string;
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

export function analyzeRecords(records: RunRecord[], protocol: Protocol, meta: AnalyzeMeta = {}): { findings: Findings; runMeta: RunMeta } {
  const n = records.length;
  if (n === 0) throw new Error('analyzeRecords: refusing to analyze at n=0 (no included sessions)');

  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const recordFindings: RecordFinding[] = [];
  const sessionsWith = new Map<DetectorName, number>();
  let k = 0;
  let toolCalls = 0;
  let errCalls = 0;
  // Ignore epoch/1970 fallbacks (a subagent transcript with no real startedAt) so the reported
  // date range reflects real activity, not the RunRecord's missing-timestamp default.
  const TS_FLOOR = '2020-01-01';
  let from = '';
  let to = '';

  const ordered = [...records].sort((a, b) => byteCompare(a.runId, b.runId));
  for (const rec of ordered) {
    const sigs = runDetectors(rec, protocol);
    const detectors = detectorSet(sigs);
    const headline = hasHeadlineSignature(sigs, protocol);
    if (headline) k++;
    for (const d of detectors) sessionsWith.set(d, (sessionsWith.get(d) ?? 0) + 1);
    const tc = rec.toolCalls.length;
    const ec = rec.toolCalls.filter((c) => c.isError).length;
    toolCalls += tc;
    errCalls += ec;
    if (rec.startedAt >= TS_FLOOR && (from === '' || rec.startedAt < from)) from = rec.startedAt;
    if (rec.endedAt >= TS_FLOOR && (to === '' || rec.endedAt > to)) to = rec.endedAt;
    const blame = blameSpan(sigs, protocol);
    recordFindings.push({
      runId: rec.runId,
      detectors,
      hasHeadlineSignature: headline,
      toolCalls: tc,
      errCalls: ec,
      signatureCount: sigs.length,
      blame: blame ? { detector: blame.detector, severity: blame.severity, turnStart: blame.turnStart, turnEnd: blame.turnEnd } : null,
    });
  }

  // Most frequent HEADLINE-set detector: sessions desc, then name asc.
  let topClass = 'none';
  let topK = 0;
  const headlineCounts = [...sessionsWith.entries()]
    .filter(([d]) => protocol.headlineSet.has(d))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (headlineCounts.length > 0 && headlineCounts[0]![1] > 0) {
    topClass = headlineCounts[0]![0];
    topK = headlineCounts[0]![1];
  }

  const kPct = wilsonPctStrings(k, n);
  const errPct = toolCalls > 0 ? wilsonPctStrings(errCalls, toolCalls) : { p: '0.0', lo: '0.0', hi: '0.0' };
  const pct: PctStrings = { p: kPct.p, lo: kPct.lo, hi: kPct.hi, err_p: errPct.p, err_lo: errPct.lo, err_hi: errPct.hi };

  const byDetector: Record<string, number> = {};
  for (const [d, c] of [...sessionsWith.entries()].sort((a, b) => a[0].localeCompare(b[0]))) byDetector[d] = c;

  // If every record lacked a valid timestamp, fall back to the raw first record's values.
  if (from === '') from = records[0]!.startedAt;
  if (to === '') to = records[0]!.endedAt;

  const findings: Findings = {
    piece: 'agent-forensics',
    protocolHash: protocol.hash,
    records: recordFindings,
    byDetector,
    generatedAt,
  };
  const runMeta: RunMeta = {
    piece: 'agent-forensics',
    protocolHash: protocol.hash,
    protocolCommit: meta.protocolCommit ?? null,
    ingestedAt: meta.ingestedAt ?? null,
    from: dateOf(from),
    to: dateOf(to),
    totalFiles: meta.totalFiles ?? n,
    excludedZeroAssistant: meta.excludedZeroAssistant ?? 0,
    sessions: n,
    k,
    toolCalls,
    errCalls,
    topClass,
    topK,
    byDetector,
    pct,
    generatedAt,
  };
  return { findings, runMeta };
}

/** Render the headline sentence from a committed run-meta object. Never hand-typed. */
export function headlineFromRunMeta(runMeta: RunMeta, protocol: Protocol): string {
  return renderHeadline(protocol.detectors.headline_template, {
    sessions: runMeta.sessions,
    from: runMeta.from,
    to: runMeta.to,
    tool_calls: runMeta.toolCalls,
    k: runMeta.k,
    p: runMeta.pct.p,
    lo: runMeta.pct.lo,
    hi: runMeta.pct.hi,
    top_class: runMeta.topClass,
    top_k: runMeta.topK,
    err_calls: runMeta.errCalls,
    err_p: runMeta.pct.err_p,
    err_lo: runMeta.pct.err_lo,
    err_hi: runMeta.pct.err_hi,
  });
}

export function writeAnalysis(dataDir: string, findings: Findings, runMeta: RunMeta): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, 'findings.json'), stableStringify(findings));
  writeFileSync(resolve(dataDir, 'run-meta.json'), stableStringify(runMeta));
}

/** Load committed RunRecords from data/records/*.json (validating each). */
export function readRecords(recordsDir: string): RunRecord[] {
  if (!existsSync(recordsDir)) return [];
  return readdirSync(recordsDir)
    .filter((f) => f.endsWith('.json'))
    .sort(byteCompare)
    .map((f) => parseRunRecord(JSON.parse(readFileSync(resolve(recordsDir, f), 'utf8')), f));
}
