import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol, DetectorName } from '../protocol';
import type { Signature } from '../signature';
import { detectLoop } from './loop';
import { detectRetry } from './retry';
import { detectApiError } from './apiError';
import { detectRefusal } from './refusal';
import { detectDangling } from './dangling';
import { detectHookError } from './hookError';
import { detectTimeout } from './timeout';
import { detectToolError } from './toolError';
import { detectDenial } from './denial';
import { detectInterrupt } from './interrupt';
import { detectCompaction } from './compaction';

export type { Signature } from '../signature';

type DetectorFn = (record: RunRecord, protocol: Protocol) => Signature[];

export const DETECTORS: ReadonlyArray<readonly [DetectorName, DetectorFn]> = [
  ['LOOP', detectLoop],
  ['RETRY', detectRetry],
  ['APIERR', detectApiError],
  ['REFUSAL', detectRefusal],
  ['DANGLE', detectDangling],
  ['HOOKERR', detectHookError],
  ['TIMEOUT', detectTimeout],
  ['TOOLERR', detectToolError],
  ['DENIAL', detectDenial],
  ['INTERRUPT', detectInterrupt],
  ['COMPACT', detectCompaction],
];

/** Run every detector and return signatures in a deterministic order. */
export function runDetectors(record: RunRecord, protocol: Protocol): Signature[] {
  const all: Signature[] = [];
  for (const [, fn] of DETECTORS) all.push(...fn(record, protocol));
  return all.sort(
    (a, b) => a.turnStart - b.turnStart || a.detector.localeCompare(b.detector) || a.turnEnd - b.turnEnd,
  );
}

/** The distinct detector names present in a signature list. */
export function detectorSet(signatures: Signature[]): DetectorName[] {
  return [...new Set(signatures.map((s) => s.detector))].sort();
}

/** True when any signature belongs to the headline set. */
export function hasHeadlineSignature(signatures: Signature[], protocol: Protocol): boolean {
  return signatures.some((s) => protocol.headlineSet.has(s.detector));
}
