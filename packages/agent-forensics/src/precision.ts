// Detector precision/recall against the labeled fixtures. This is measured against the
// detectors' OWN specification (each fixture is labelled with the signatures it was built to
// contain), NOT real-world precision — a labeled synthetic corpus cannot speak to prevalence
// or to detectors missing genuinely novel breakdowns.

import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol, DetectorName } from './protocol';
import { DETECTORS, runDetectors, detectorSet } from './detectors';

export interface DetectorPR {
  detector: DetectorName;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

export interface PrecisionReport {
  note: string;
  n: number;
  perDetector: DetectorPR[];
}

const NOTE = 'measured against the detectors’ own specification, not real-world precision';

/**
 * For each detector, compare the labelled ground truth (record.labels) with the detected set.
 * precision/recall are 1 when there are no false positives / false negatives, and 1 by
 * convention when a detector is absent from every fixture (tp=fp=fn=0).
 */
export function precisionRecall(records: RunRecord[], protocol: Protocol): PrecisionReport {
  const perDetector: DetectorPR[] = [];
  for (const [name] of DETECTORS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const rec of records) {
      const truth = new Set((rec.labels ?? []) as DetectorName[]);
      const predicted = new Set(detectorSet(runDetectors(rec, protocol)));
      const inTruth = truth.has(name);
      const inPred = predicted.has(name);
      if (inTruth && inPred) tp++;
      else if (!inTruth && inPred) fp++;
      else if (inTruth && !inPred) fn++;
    }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    perDetector.push({ detector: name, tp, fp, fn, precision, recall });
  }
  return { note: NOTE, n: records.length, perDetector };
}
