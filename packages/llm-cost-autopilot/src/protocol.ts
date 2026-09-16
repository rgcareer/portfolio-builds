// Loads the two frozen protocol files (verified prices + static policy) and computes a
// single hash over their raw bytes. Any edit to either file — after data collection has
// started — changes the hash, so a protocol-frozen audit can catch it.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '@portfolio-builds/shared';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL_DIR = resolve(PKG_ROOT, 'protocol');
export const DATA_DIR = resolve(PKG_ROOT, 'data');

export interface ModelPriceEntry {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  minCacheablePrefix: number;
}

export interface PricesFile {
  version: number;
  source: string;
  verified_on: string;
  unit: string;
  note: string;
  batch_multiplier: number;
  models: Record<string, ModelPriceEntry>;
  excluded_models: Record<string, string>;
}

export interface PolicyFile {
  version: number;
  frozen_on: string;
  window: { from: string; to: string };
  dedupe_key: string;
  inclusion: string;
  exclusion_reasons: string[];
  redaction: { session: string; project: string; dropped: string[] };
  counterfactual: {
    nocache: string;
    batch_only_if_latency_tolerant: boolean;
    routing_excluded_quality_unverified: boolean;
    ledger_ttl_assumed: string;
  };
  bootstrap: { B: number; seed: number; unit: string };
  headline_template: string;
  not_measured: string[];
}

export interface Protocol {
  rules: PolicyFile;
  prices: PricesFile;
  /** sha256 over the raw text of both committed protocol files, in a stable order. */
  hash: string;
}

export function loadPolicy(dir: string = PROTOCOL_DIR): Protocol {
  const pricesJson = readFileSync(resolve(dir, 'prices.json'), 'utf8');
  const policyJson = readFileSync(resolve(dir, 'policy.json'), 'utf8');
  const prices = JSON.parse(pricesJson) as PricesFile;
  const rules = JSON.parse(policyJson) as PolicyFile;
  return { rules, prices, hash: sha256Canonical([pricesJson, policyJson]) };
}
