// Timeline construction over a RunRecord: an ordered view of turns with their tool calls
// attached, plus the derived blame span (the earliest highest-severity signature) and a
// minimal repro slice (the shortest suffix that still reproduces that signature).

import type { RunRecord, ToolCall } from '@portfolio-builds/shared';
import type { Protocol, DetectorName } from './protocol';
import { severityRank } from './protocol';
import type { Signature } from './signature';
import { DETECTORS, runDetectors } from './detectors';

export interface TimelineCall {
  id: string;
  name: string;
  isError: boolean;
  errorClass: string | null;
  resultTurn: number | null;
  orphan: boolean;
  timedOut: boolean;
  denied: boolean;
  interrupted: boolean;
}

export interface TimelineEntry {
  index: number;
  kind: string;
  at: string;
  model?: string;
  stopReason?: string;
  eventType?: string;
  errorClass?: string;
  calls: TimelineCall[];
}

export interface MinimalRepro {
  detector: DetectorName;
  startTurn: number;
  turns: number;
  toolCallIds: string[];
}

export interface Timeline {
  entries: TimelineEntry[];
  signatures: Signature[];
  blame: Signature | null;
  repro: MinimalRepro | null;
}

const DETECTOR_FN = new Map(DETECTORS);

function toTimelineCall(c: ToolCall): TimelineCall {
  return {
    id: c.id,
    name: c.name,
    isError: c.isError,
    errorClass: c.errorClass,
    resultTurn: c.resultTurn,
    orphan: c.orphan,
    timedOut: c.timedOut,
    denied: c.denied,
    interrupted: c.interrupted,
  };
}

/** The earliest highest-severity signature; ties break by earliest turnStart, then name. */
export function blameSpan(signatures: Signature[], protocol: Protocol): Signature | null {
  let best: Signature | null = null;
  for (const s of signatures) {
    if (best === null) {
      best = s;
      continue;
    }
    const sr = severityRank(protocol, s.severity);
    const br = severityRank(protocol, best.severity);
    if (sr > br) best = s;
    else if (sr === br && s.turnStart < best.turnStart) best = s;
    else if (sr === br && s.turnStart === best.turnStart && s.detector < best.detector) best = s;
  }
  return best;
}

function sliceRecord(record: RunRecord, start: number): RunRecord {
  return {
    ...record,
    turns: record.turns.filter((t) => t.index >= start),
    toolCalls: record.toolCalls.filter((c) => c.callTurn >= start),
  };
}

/**
 * Shortest suffix that still reproduces `signature`'s detector: the largest start index at
 * or before the signature's own start for which the detector still fires.
 */
export function minimalRepro(record: RunRecord, signature: Signature, protocol: Protocol): MinimalRepro {
  const fn = DETECTOR_FN.get(signature.detector);
  if (!fn) throw new Error(`minimalRepro: no detector ${signature.detector}`);
  let bestStart = 0;
  let bestSig: Signature | null = null;
  for (let s = 0; s <= signature.turnStart; s++) {
    const found = fn(sliceRecord(record, s), protocol);
    if (found.length > 0) {
      bestStart = s;
      bestSig = found[0]!;
    }
  }
  const sub = sliceRecord(record, bestStart);
  return {
    detector: signature.detector,
    startTurn: bestStart,
    turns: sub.turns.length,
    toolCallIds: bestSig ? bestSig.toolCallIds : signature.toolCallIds,
  };
}

/** Build the full timeline: ordered entries + signatures + blame + minimal repro. */
export function buildTimeline(record: RunRecord, protocol: Protocol): Timeline {
  const callsByTurn = new Map<number, ToolCall[]>();
  for (const c of record.toolCalls) {
    const arr = callsByTurn.get(c.callTurn);
    if (arr) arr.push(c);
    else callsByTurn.set(c.callTurn, [c]);
  }
  const entries: TimelineEntry[] = [...record.turns]
    .sort((a, b) => a.index - b.index)
    .map((t) => {
      const entry: TimelineEntry = { index: t.index, kind: t.kind, at: t.at, calls: (callsByTurn.get(t.index) ?? []).map(toTimelineCall) };
      if (t.model !== undefined) entry.model = t.model;
      if (t.stopReason !== undefined) entry.stopReason = t.stopReason;
      if (t.eventType !== undefined) entry.eventType = t.eventType;
      if (t.error?.class !== undefined) entry.errorClass = t.error.class;
      return entry;
    });
  const signatures = runDetectors(record, protocol);
  const blame = blameSpan(signatures, protocol);
  const repro = blame ? minimalRepro(record, blame, protocol) : null;
  return { entries, signatures, blame, repro };
}
