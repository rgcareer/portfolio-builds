// Loads the pre-registered protocol (cache rules + paraphrase set) and computes its hash.
// The hash is committed into run-meta.json when the curve is generated; a `protocol-frozen`
// audit fails if the committed protocol no longer matches, so the rules and the labelled
// near-miss set cannot be tuned after the sweep has run.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '@portfolio-builds/shared';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL_DIR = resolve(PKG_ROOT, 'protocol');
export const DATA_DIR = resolve(PKG_ROOT, 'data');

export interface TauGrid {
  start: number;
  stop: number;
  step: number;
}

export interface CacheRules {
  version: number;
  frozen_on: string;
  embedding: { model: string; dtype: string; pooling: string; normalize: boolean; dims: number };
  namespace: { fields: string[] };
  refusal: {
    time_regex: string;
    time_regex_flags: string;
    pii_kinds: string[];
  };
  guards: {
    numeric_token_regex: string;
    identifier_regex: string;
    negation_words: string[];
  };
  sweep: { tau_grid: TauGrid; shipped_tau: number };
  cache: { ttl_default_ms: number; max_entries_default: number };
  headline_template: string;
  not_measured: string[];
}

export interface NegativeTemplate {
  kind: 'slot-swap' | 'polarity' | 'entity';
  template: string;
}

export interface IntentDef {
  id: string;
  domain: string;
  verb: string;
  entity: string;
  altEntity: string;
  base: { template: string; slots: Record<string, string[]> };
  paraphrases: string[];
  negatives: NegativeTemplate[];
}

export interface ParaphraseSet {
  version: number;
  seed: number;
  slotName: string;
  intents: IntentDef[];
}

export interface Protocol {
  cacheRules: CacheRules;
  paraphraseSet: ParaphraseSet;
  /** sha256 over the canonical JSON of both files together. */
  hash: string;
}

export function loadProtocol(dir: string = PROTOCOL_DIR): Protocol {
  const cacheRules = JSON.parse(readFileSync(resolve(dir, 'cache-rules.json'), 'utf8')) as CacheRules;
  const paraphraseSet = JSON.parse(readFileSync(resolve(dir, 'paraphrase-set.json'), 'utf8')) as ParaphraseSet;
  return { cacheRules, paraphraseSet, hash: sha256Canonical({ cacheRules, paraphraseSet }) };
}
