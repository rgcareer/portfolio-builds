// Builds the committed run-meta object and renders the headline. Every headline number comes
// from the Comparison (which came from the ledgered runs) and is rendered ONLY through
// renderHeadline against the frozen template — a missing value throws rather than prints a
// placeholder. The paired denominator n is used for both conditions and the difference, so
// {kA}/{n}, {kB}/{n}, and {diff} are internally consistent.

import { renderHeadline, wilsonPctStrings, type HeadlineValue } from '@portfolio-builds/shared';
import type { Protocol } from './protocol';
import type { Comparison } from './compare';

export interface RunMetaInputs {
  runDate: string;
  ledgerTotalUsd: number;
  ledgerCalls: number;
  protocolCommit: string | null;
  frozenAt: string | null;
  ranAt: string | null;
  generatedAt: string;
}

export interface ConditionMeta {
  name: string;
  model: string;
  k: number;
  pct: { p: string; lo: string; hi: string };
  costPerItemUsd: number;
  skipped: number;
}

export interface RunMeta {
  piece: 'model-regress';
  generatedAt: string;
  protocolHash: string;
  goldenHash: string;
  protocolCommit: string | null;
  frozenAt: string | null;
  ranAt: string | null;
  runDate: string;
  n: number;
  conditionA: ConditionMeta;
  conditionB: ConditionMeta;
  paired: { diffPp: string; loPp: string; hiPp: string; mcnemarP: number };
  noise: { disagree: number; upperPp: string } | null;
  cost: { perItemAUsd: number; perItemBUsd: number; ledgerTotalUsd: number; ledgerCalls: number };
  headlineValues: Record<string, HeadlineValue> | null;
  headline: string | null;
}

const COST_DECIMALS = 5;

function signed1(x: number): string {
  return x.toFixed(1);
}

/** The exact placeholder map the headline template needs, or null when not yet renderable. */
function headlineValues(proto: Protocol, cmp: Comparison, runDate: string): Record<string, HeadlineValue> | null {
  if (cmp.nPaired === 0 || !cmp.noise) return null;
  const n = cmp.nPaired;
  const a = wilsonPctStrings(cmp.pairedKA, n);
  const b = wilsonPctStrings(cmp.pairedKB, n);
  void proto;
  return {
    n,
    date: runDate,
    modelA: cmp.a.model,
    kA: cmp.pairedKA,
    pA: a.p,
    loA: a.lo,
    hiA: a.hi,
    modelB: cmp.b.model,
    kB: cmp.pairedKB,
    pB: b.p,
    loB: b.lo,
    hiB: b.hi,
    diff: signed1(cmp.diffPp),
    dlo: signed1(cmp.loPp),
    dhi: signed1(cmp.hiPp),
    noiseK: cmp.noise.disagree,
    cA: cmp.a.costPerItem.toFixed(COST_DECIMALS),
    cB: cmp.b.costPerItem.toFixed(COST_DECIMALS),
  };
}

export function buildRunMeta(proto: Protocol, cmp: Comparison, inputs: RunMetaInputs): RunMeta {
  const values = headlineValues(proto, cmp, inputs.runDate);
  const headline = values ? renderHeadline(proto.experiment.headline_template, values) : null;

  const condA: ConditionMeta = {
    name: cmp.a.name,
    model: cmp.a.model,
    k: cmp.pairedKA,
    pct: cmp.nPaired > 0 ? wilsonPctStrings(cmp.pairedKA, cmp.nPaired) : { p: '0.0', lo: '0.0', hi: '0.0' },
    costPerItemUsd: cmp.a.costPerItem,
    skipped: cmp.a.skipped,
  };
  const condB: ConditionMeta = {
    name: cmp.b.name,
    model: cmp.b.model,
    k: cmp.pairedKB,
    pct: cmp.nPaired > 0 ? wilsonPctStrings(cmp.pairedKB, cmp.nPaired) : { p: '0.0', lo: '0.0', hi: '0.0' },
    costPerItemUsd: cmp.b.costPerItem,
    skipped: cmp.b.skipped,
  };

  return {
    piece: 'model-regress',
    generatedAt: inputs.generatedAt,
    protocolHash: proto.hash,
    goldenHash: proto.goldenHash,
    protocolCommit: inputs.protocolCommit,
    frozenAt: inputs.frozenAt,
    ranAt: inputs.ranAt,
    runDate: inputs.runDate,
    n: cmp.nPaired,
    conditionA: condA,
    conditionB: condB,
    paired: { diffPp: signed1(cmp.diffPp), loPp: signed1(cmp.loPp), hiPp: signed1(cmp.hiPp), mcnemarP: cmp.mcnemarP },
    noise: cmp.noise ? { disagree: cmp.noise.disagree, upperPp: signed1(cmp.noise.upperPp) } : null,
    cost: { perItemAUsd: cmp.a.costPerItem, perItemBUsd: cmp.b.costPerItem, ledgerTotalUsd: inputs.ledgerTotalUsd, ledgerCalls: inputs.ledgerCalls },
    headlineValues: values,
    headline,
  };
}

/** Render the headline from a committed run-meta object (throws if values are missing). */
export function headlineFromMeta(proto: Protocol, meta: RunMeta): string {
  if (!meta.headlineValues) throw new Error('run-meta has no headline values yet (no paired run has produced them)');
  return renderHeadline(proto.experiment.headline_template, meta.headlineValues);
}
