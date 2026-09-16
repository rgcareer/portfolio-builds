// Loads the pre-registered protocol (corpus rule + check set) and computes its hash.
// The hash is written into run-state.json/run-meta.json; a `protocol-frozen` audit fails
// if the committed protocol no longer matches what data collection was run against.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '@portfolio-builds/shared';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL_DIR = resolve(PKG_ROOT, 'protocol');
export const DATA_DIR = resolve(PKG_ROOT, 'data');
export const OUT_DIR = resolve(PKG_ROOT, 'out');

export interface OwnRepoRule {
  id: string;
  local: string;
  url: string;
  files: string;
}

export interface SiteRule {
  id: string;
  origin: string;
  depth: number;
  use_sitemap: boolean;
  sitemap_path: string;
}

export interface ExternalRule {
  id: string;
  pointer: string;
  id_prefix: string;
  otr_protocol_hash: string;
  otr_commit: string;
}

export interface LinkRule {
  exclude_re: string;
  own_max_links: number | null;
  external_max_links: number;
}

export interface FetchRule {
  timeout_ms: number;
  max_bytes: number;
  user_agent: string;
  concurrency: number;
  per_host_gap_ms: number;
  retries: number;
}

export interface CorpusRule {
  version: number;
  frozen_on: string;
  own_repos: OwnRepoRule[];
  tree_exclude_re: string;
  site: SiteRule;
  external: ExternalRule;
  link: LinkRule;
  fetch: FetchRule;
}

export interface CheckDef {
  id: string;
  category: string;
  description: string;
  counted: boolean;
  reverify_methods: string[];
  [key: string]: unknown;
}

export interface FixPolicyEntry {
  proposal: string | null;
  safe_to_auto_apply_when?: string;
  proposed_unsafe_when?: string;
  flag_only_when?: string;
}

export interface Checks {
  version: number;
  frozen_on: string;
  checks: CheckDef[];
  drift_categories: string[];
  fix_policy: Record<string, FixPolicyEntry>;
  reverify_methods: Record<string, { description: string; applies_to: string[] }>;
  pass_definition: string;
  headline_template: string;
  sub_headline_template: string;
  no_proposals_text: string;
  stats: { interval: string; rule: string };
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

export function checkById(checks: Checks, id: string): CheckDef {
  const c = checks.checks.find((x) => x.id === id);
  if (!c) throw new Error(`protocol: unknown check ${id}`);
  return c;
}

export function fixPolicyFor(checks: Checks, category: string): FixPolicyEntry {
  const p = checks.fix_policy[category];
  if (!p) throw new Error(`protocol: no fix_policy for category ${category}`);
  return p;
}
