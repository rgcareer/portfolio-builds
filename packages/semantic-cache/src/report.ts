// Builds the committed run-meta.json values and renders the headline through
// renderHeadline — the only path a portfolio-facing number is allowed to reach text through.
// Pure function of (curve, protocol); no I/O.

import { renderHeadline, wilsonPctStrings, type HeadlineValue } from '@portfolio-builds/shared';
import type { SweepPoint } from './sweep';
import type { Protocol } from './protocol';

export interface RunMeta {
  generatedAt: string;
  protocolHash: string;
  shippedTau: number;
  nItems: number;
  nBase: number;
  kPara: number;
  kNeg: number;
  nPara: number;
  nNeg: number;
  kHit: number;
  kFp: number;
  hitPct: string;
  hitLo: string;
  hitHi: string;
  fpPct: string;
  fpLo: string;
  fpHi: string;
  headline: string;
  costUsd: 0;
  notMeasured: string[];
}

function findShippedPoint(curve: SweepPoint[], shippedTau: number): SweepPoint {
  const point = curve.find((p) => Math.abs(p.tau - shippedTau) < 1e-9);
  if (!point) throw new Error(`report: no sweep point at shipped_tau=${shippedTau} (curve taus: ${curve.map((p) => p.tau).join(', ')})`);
  return point;
}

export function buildRunMeta(curve: SweepPoint[], protocol: Protocol, generatedAt: string): RunMeta {
  const { cacheRules, paraphraseSet } = protocol;
  const shippedTau = cacheRules.sweep.shipped_tau;
  const point = findShippedPoint(curve, shippedTau);

  const nBase = paraphraseSet.intents.length;
  if (nBase === 0) throw new Error('report: paraphrase set has no intents');
  const kPara = paraphraseSet.intents[0]!.paraphrases.length;
  const kNeg = paraphraseSet.intents[0]!.negatives.length;
  for (const intent of paraphraseSet.intents) {
    if (intent.paraphrases.length !== kPara) throw new Error(`report: intent ${intent.id} has a non-uniform paraphrase count`);
    if (intent.negatives.length !== kNeg) throw new Error(`report: intent ${intent.id} has a non-uniform negative count`);
  }

  const hit = wilsonPctStrings(point.hit.k, point.hit.n);
  const fp = wilsonPctStrings(point.falseHit.k, point.falseHit.n);

  const values: Record<string, HeadlineValue> = {
    nItems: nBase * (1 + kPara + kNeg),
    nBase,
    kPara,
    kNeg,
    tau: shippedTau.toFixed(2),
    kHit: point.hit.k,
    nPara: point.hit.n,
    hitPct: hit.p,
    hitLo: hit.lo,
    hitHi: hit.hi,
    kFp: point.falseHit.k,
    nNeg: point.falseHit.n,
    fpPct: fp.p,
    fpLo: fp.lo,
    fpHi: fp.hi,
  };

  const headline = renderHeadline(cacheRules.headline_template, values);

  return {
    generatedAt,
    protocolHash: protocol.hash,
    shippedTau,
    nItems: values.nItems as number,
    nBase,
    kPara,
    kNeg,
    nPara: point.hit.n,
    nNeg: point.falseHit.n,
    kHit: point.hit.k,
    kFp: point.falseHit.k,
    hitPct: hit.p,
    hitLo: hit.lo,
    hitHi: hit.hi,
    fpPct: fp.p,
    fpLo: fp.lo,
    fpHi: fp.hi,
    headline,
    costUsd: 0,
    notMeasured: cacheRules.not_measured,
  };
}
