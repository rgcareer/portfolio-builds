// Prices real usage against the verified table in protocol/prices.json — never against a
// hard-coded number in this file. Every dollar figure this package prints traces back to
// these three functions plus the committed table.

import { LLM_PRICES, type TrafficUsage } from '@portfolio-builds/shared';
import { loadPolicy, type PricesFile, type ModelPriceEntry } from './protocol';

let cached: PricesFile | null = null;

/** The verified table (protocol/prices.json), loaded once and memoized. */
function prices(): PricesFile {
  if (!cached) cached = loadPolicy().prices;
  return cached;
}

function priceEntry(model: string): ModelPriceEntry {
  const m = prices().models[model];
  if (!m) throw new Error(`prices: no verified price for model "${model}" (see protocol/prices.json)`);
  return m;
}

export interface PriceBreakdown {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

/**
 * Billed = input·in + cacheCreation5m·1.25·in + cacheCreation1h·2·in + cacheRead·cacheRead·in
 * + output·out (all /1e6). `batch` applies the flat batch multiplier on top of (stacked with)
 * whatever cache discount already applied. Throws on an unpriced model — this function never
 * silently prices at a guessed rate.
 */
export function priceUsage(model: string, usage: TrafficUsage, opts: { batch?: boolean } = {}): PriceBreakdown {
  const m = priceEntry(model);
  const batchMul = opts.batch ? prices().batch_multiplier : 1;
  const rawInputUsd =
    usage.input * m.in +
    usage.cacheCreation5m * m.cacheWrite5m * m.in +
    usage.cacheCreation1h * m.cacheWrite1h * m.in +
    usage.cacheRead * m.cacheRead * m.in;
  const rawOutputUsd = usage.output * m.out;
  const inputUsd = (rawInputUsd / 1e6) * batchMul;
  const outputUsd = (rawOutputUsd / 1e6) * batchMul;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

/**
 * The "what if caching never happened" usage: every input-class token (fresh, cache-read,
 * cache-creation) is re-attributed to fresh input at the model's list rate. Output is
 * unchanged — caching never touches output pricing.
 */
export function noCacheCounterfactual(usage: TrafficUsage): TrafficUsage {
  return {
    input: usage.input + usage.cacheRead + usage.cacheCreation5m + usage.cacheCreation1h,
    cacheRead: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    output: usage.output,
  };
}

/** The verified minimum cacheable prefix length (tokens) for a model. */
export function minCacheablePrefix(model: string): number {
  return priceEntry(model).minCacheablePrefix;
}

/** True when a model appears in the verified table (i.e. this package can price it). */
export function isPricedModel(model: string): boolean {
  return model in prices().models;
}

/** The model id with the lowest in+out list rate in the verified table. */
export function cheapestPricedModel(): string {
  let best: string | null = null;
  let bestSum = Infinity;
  for (const [model, entry] of Object.entries(prices().models)) {
    const sum = entry.in + entry.out;
    if (sum < bestSum) {
      bestSum = sum;
      best = model;
    }
  }
  if (!best) throw new Error('prices: verified table has no models');
  return best;
}

/**
 * Names any model present in BOTH the verified table and shared's LLM_PRICES whose in/out
 * rate differs between the two. A model tracked only by one side is not comparable and is
 * not reported as drift.
 */
export function driftVsShared(): string[] {
  const drift: string[] = [];
  for (const [model, entry] of Object.entries(prices().models)) {
    const shared = LLM_PRICES[model];
    if (!shared) continue;
    if (shared.in !== entry.in || shared.out !== entry.out) drift.push(model);
  }
  return drift;
}
