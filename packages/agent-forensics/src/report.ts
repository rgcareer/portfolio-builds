// Per-record post-mortem report: the detected signatures, the blame span, the minimal repro
// slice, and a compact timeline. Everything here is scalar/enum/hash — safe to print or
// commit. The MAST category is the author's mapping (no prevalence claim).

import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol, DetectorName, MastCategory } from './protocol';
import { mastCategory } from './protocol';
import { buildTimeline, type TimelineEntry, type MinimalRepro } from './timeline';
import type { Signature } from './signature';

export interface SignatureView {
  detector: DetectorName;
  category: MastCategory;
  severity: string;
  turnStart: number;
  turnEnd: number;
  toolCallIds: string[];
  evidence: Signature['evidence'];
  headline: boolean;
}

export interface Report {
  runId: string;
  source: string;
  from: string;
  to: string;
  outcome: string;
  models: string[];
  toolCalls: number;
  errCalls: number;
  turns: number;
  signatures: SignatureView[];
  blame: SignatureView | null;
  repro: MinimalRepro | null;
  timeline: TimelineEntry[];
  notMeasured: string[];
}

function view(sig: Signature, protocol: Protocol): SignatureView {
  return {
    detector: sig.detector,
    category: mastCategory(protocol, sig.detector),
    severity: sig.severity,
    turnStart: sig.turnStart,
    turnEnd: sig.turnEnd,
    toolCallIds: sig.toolCallIds,
    evidence: sig.evidence,
    headline: protocol.headlineSet.has(sig.detector),
  };
}

export function report(record: RunRecord, protocol: Protocol): Report {
  const tl = buildTimeline(record, protocol);
  return {
    runId: record.runId,
    source: record.source.kind,
    from: record.startedAt,
    to: record.endedAt,
    outcome: record.outcome.status,
    models: record.models,
    toolCalls: record.toolCalls.length,
    errCalls: record.toolCalls.filter((c) => c.isError).length,
    turns: record.turns.length,
    signatures: tl.signatures.map((s) => view(s, protocol)),
    blame: tl.blame ? view(tl.blame, protocol) : null,
    repro: tl.repro,
    timeline: tl.entries,
    notMeasured: protocol.detectors.not_measured,
  };
}

/** A compact human-readable rendering of a report (for the CLI without --json). */
export function renderReportText(r: Report): string {
  const lines: string[] = [];
  lines.push(`run ${r.runId}  [${r.source}]  ${r.outcome}`);
  lines.push(`  ${r.from} → ${r.to}  ·  ${r.turns} turns  ·  ${r.toolCalls} tool calls (${r.errCalls} errored)`);
  lines.push(`  models: ${r.models.join(', ') || '(none)'}`);
  if (r.signatures.length === 0) {
    lines.push('  signatures: none');
  } else {
    lines.push(`  signatures (${r.signatures.length}):`);
    for (const s of r.signatures) {
      lines.push(`    ${s.detector} [${s.severity}/${s.category}]${s.headline ? ' *headline' : ''}  turns ${s.turnStart}-${s.turnEnd}  ${JSON.stringify(s.evidence)}`);
    }
  }
  if (r.blame) lines.push(`  blame: ${r.blame.detector} at turn ${r.blame.turnStart}`);
  if (r.repro) lines.push(`  minimal repro: ${r.repro.detector} from turn ${r.repro.startTurn} (${r.repro.turns} turns)`);
  return lines.join('\n');
}
