// Loads the pre-registered detector protocol (detectors.json + taxonomy.json) and computes
// its hash. The hash is written into run-state.json / run-meta.json at ingest time; the
// protocol-frozen audit fails if the committed protocol no longer matches, so the detectors,
// thresholds, allowlists, and headline template cannot be tuned after the data is collected.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '@portfolio-builds/shared';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL_DIR = resolve(PKG_ROOT, 'protocol');
export const DATA_DIR = resolve(PKG_ROOT, 'data');
export const FIXTURES_DIR = resolve(PKG_ROOT, 'fixtures');

export type MastCategory = 'system-design' | 'inter-agent' | 'verification';
export type Severity = 'info' | 'low' | 'medium' | 'high';
export type DetectorName =
  | 'LOOP'
  | 'RETRY'
  | 'APIERR'
  | 'REFUSAL'
  | 'DANGLE'
  | 'HOOKERR'
  | 'TIMEOUT'
  | 'TOOLERR'
  | 'DENIAL'
  | 'INTERRUPT'
  | 'COMPACT';

export interface DetectorDef {
  severity: Severity;
  description: string;
  window?: number;
  min_repeats?: number;
  min_consecutive_errors?: number;
  min_calls?: number;
  min_errors?: number;
  headline?: boolean;
}

export interface DetectorsFile {
  version: number;
  frozen_on: string;
  source: string;
  parse: Record<string, string>;
  tool_use_result: {
    kept_keys: string[];
    status_re: string;
    never_kept: string[];
  };
  first_party_tools: string[];
  error_classes: {
    order: string[];
    regex: Record<string, string>;
    fallback: string;
  };
  detectors: Record<DetectorName, DetectorDef>;
  severity_rank: Record<Severity, number>;
  headline_set: DetectorName[];
  denominators: Record<string, string>;
  headline_template: string;
  not_measured: string[];
}

export interface TaxonomyFile {
  version: number;
  frozen_on: string;
  note: string;
  categories: MastCategory[];
  map: Record<DetectorName, MastCategory>;
}

export interface Protocol {
  detectors: DetectorsFile;
  taxonomy: TaxonomyFile;
  /** sha256 over the canonical JSON of both protocol files together. */
  hash: string;
  // Precompiled, order-preserving views used on the hot path.
  keptKeys: Set<string>;
  neverKept: Set<string>;
  firstPartyTools: Set<string>;
  statusRe: RegExp;
  errorClassRegexes: ReadonlyArray<{ label: string; re: RegExp }>;
  errorClassFallback: string;
  headlineSet: Set<DetectorName>;
}

export function loadProtocol(dir: string = PROTOCOL_DIR): Protocol {
  const detectors = JSON.parse(readFileSync(resolve(dir, 'detectors.json'), 'utf8')) as DetectorsFile;
  const taxonomy = JSON.parse(readFileSync(resolve(dir, 'taxonomy.json'), 'utf8')) as TaxonomyFile;
  return buildProtocol(detectors, taxonomy);
}

/** Build a Protocol from already-parsed files (used by tests and repro). */
export function buildProtocol(detectors: DetectorsFile, taxonomy: TaxonomyFile): Protocol {
  const errorClassRegexes = detectors.error_classes.order.map((label) => {
    const src = detectors.error_classes.regex[label];
    if (!src) throw new Error(`protocol: error class ${label} listed in order but has no regex`);
    return { label, re: new RegExp(src) };
  });
  return {
    detectors,
    taxonomy,
    hash: sha256Canonical({ detectors, taxonomy }),
    keptKeys: new Set(detectors.tool_use_result.kept_keys),
    neverKept: new Set(detectors.tool_use_result.never_kept),
    firstPartyTools: new Set(detectors.first_party_tools),
    statusRe: new RegExp(detectors.tool_use_result.status_re),
    errorClassRegexes,
    errorClassFallback: detectors.error_classes.fallback,
    headlineSet: new Set(detectors.headline_set),
  };
}

export function detectorDef(protocol: Protocol, name: DetectorName): DetectorDef {
  const d = protocol.detectors.detectors[name];
  if (!d) throw new Error(`protocol: unknown detector ${name}`);
  return d;
}

export function severityRank(protocol: Protocol, severity: Severity): number {
  return protocol.detectors.severity_rank[severity] ?? 0;
}

export function mastCategory(protocol: Protocol, name: DetectorName): MastCategory {
  return protocol.taxonomy.map[name];
}
