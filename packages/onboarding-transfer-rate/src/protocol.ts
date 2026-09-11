// Loads the pre-registered protocol (corpus rule + check set) and computes its hash.
// The hash is written into run-meta.json at seed time; a test fails if the committed
// protocol no longer matches, so the checks cannot be tuned after the data is in.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '@portfolio-builds/shared';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL_DIR = resolve(PKG_ROOT, 'protocol');
export const DATA_DIR = resolve(PKG_ROOT, 'data');

export interface ProbeSpec {
  id: string;
  rule: string;
  paths?: string[];
}

export interface CorpusRule {
  version: number;
  frozen_on: string;
  seed: { endpoint: string; queries: string[]; params: { sort: string; order: string; per_page: number; page: number } };
  target_n: number;
  quickstart: { text_re: string; text_re_flags: string; probe_order: ProbeSpec[]; render_blocked_fallback: string };
  fetch: { timeout_ms: number; max_bytes: number; user_agent: string };
}

export interface L1Check {
  id: string;
  category: string;
  description: string;
  stratum?: boolean;
  install_patterns?: Record<string, string>;
  registry?: Record<string, string>;
  pin_patterns?: Record<string, string>;
  max_links?: number;
  exclude_re?: string;
  env_var_patterns?: string[];
  tools?: string[];
  languages?: Record<string, string[]>;
  pattern?: string;
  flags?: string;
}

export interface Checks {
  version: number;
  frozen_on: string;
  l0: {
    milestone: { id: string; patterns: string[]; flags: string };
    time_claim: { id: string; pattern: string; flags: string };
  };
  l1: L1Check[];
  l1_pass_definition: string;
  headline_template: string;
  not_measured: string[];
}

export interface Protocol {
  corpusRule: CorpusRule;
  checks: Checks;
  /** sha256 over the canonical JSON of both files together. */
  hash: string;
}

export function loadProtocol(dir: string = PROTOCOL_DIR): Protocol {
  const corpusRule = JSON.parse(readFileSync(resolve(dir, 'corpus-rule.json'), 'utf8')) as CorpusRule;
  const checks = JSON.parse(readFileSync(resolve(dir, 'checks.json'), 'utf8')) as Checks;
  return { corpusRule, checks, hash: sha256Canonical({ corpusRule, checks }) };
}

export function l1Check(checks: Checks, id: string): L1Check {
  const c = checks.l1.find((x) => x.id === id);
  if (!c) throw new Error(`protocol: unknown L1 check ${id}`);
  return c;
}
