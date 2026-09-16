// Sweeps the shipped guard/threshold policy across a grid of tau values against the
// hand-labelled paraphrase set, producing the hit-rate / false-hit-rate curve that the
// headline is rendered from. Pure function of (items, vecs, grid, guardsEnabled, rules) —
// no I/O, no randomness — so `repro` can re-derive it bit-for-bit from committed inputs.

import { wilson, type WilsonInterval } from '@portfolio-builds/shared';
import { cosine } from './similarity';
import { slotGuard } from './guards';
import type { LabeledItem } from './labelset';
import type { CacheRules, TauGrid } from './protocol';

export interface SweepPoint {
  tau: number;
  hit: WilsonInterval;
  falseHit: WilsonInterval;
}

/** Inclusive tau values from `start` to `stop`, stepping by `step`, rounded to 2 decimals. */
export function tauGrid(grid: TauGrid): number[] {
  const count = Math.round((grid.stop - grid.start) / grid.step);
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(Math.round((grid.start + i * grid.step) * 100) / 100);
  return out;
}

interface IntentGroup {
  base: LabeledItem;
  paraphrases: LabeledItem[];
  negatives: LabeledItem[];
}

function groupByIntent(items: LabeledItem[]): IntentGroup[] {
  const byIntent = new Map<string, IntentGroup>();
  for (const item of items) {
    let group = byIntent.get(item.intentId);
    if (!group) {
      group = { base: item.role === 'base' ? item : (undefined as unknown as LabeledItem), paraphrases: [], negatives: [] };
      byIntent.set(item.intentId, group);
    }
    if (item.role === 'base') group.base = item;
    else if (item.role === 'paraphrase') group.paraphrases.push(item);
    else group.negatives.push(item);
  }
  return [...byIntent.values()];
}

/**
 * hit = a paraphrase matches its base at sim >= tau (and, when guards are enabled, the
 * guard does not veto). falseHit = a negative matches its base the same way. Wilson
 * intervals are computed on both counts at every tau.
 */
export function sweep(items: LabeledItem[], vecs: Map<string, Float32Array>, grid: TauGrid, guardsEnabled: boolean, rules: CacheRules): SweepPoint[] {
  const groups = groupByIntent(items);
  const taus = tauGrid(grid);

  return taus.map((tau) => {
    let hitK = 0;
    let hitN = 0;
    let fpK = 0;
    let fpN = 0;
    for (const group of groups) {
      const baseVec = vecs.get(group.base.id);
      if (!baseVec) throw new Error(`sweep: missing embedding for ${group.base.id}`);

      for (const para of group.paraphrases) {
        hitN++;
        const vec = vecs.get(para.id);
        if (!vec) throw new Error(`sweep: missing embedding for ${para.id}`);
        const sim = cosine(baseVec, vec);
        const guardOk = !guardsEnabled || !slotGuard(group.base.text, para.text, rules).veto;
        if (sim >= tau && guardOk) hitK++;
      }

      for (const neg of group.negatives) {
        fpN++;
        const vec = vecs.get(neg.id);
        if (!vec) throw new Error(`sweep: missing embedding for ${neg.id}`);
        const sim = cosine(baseVec, vec);
        const guardOk = !guardsEnabled || !slotGuard(group.base.text, neg.text, rules).veto;
        if (sim >= tau && guardOk) fpK++;
      }
    }
    return { tau, hit: wilson(hitK, hitN), falseHit: wilson(fpK, fpN) };
  });
}
