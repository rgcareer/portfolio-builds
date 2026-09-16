// Loads the pre-registered experiment protocol and computes its hash. The hash covers BOTH
// experiment.json AND the golden set — and because the golden set is deterministic from the
// frozen seed/n, the hash is regenerated from the generator rather than a committed file, so
// it is stable offline and cannot be forked by editing the committed golden. run-state.json
// records the frozen hash and the commit; protocolFrozenAudit fails if either drifted.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical, type ModelPrice } from '@portfolio-builds/shared';
import { generateGolden, goldenHash, loadGolden, type GoldenItem } from './golden';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL_DIR = resolve(PKG_ROOT, 'protocol');
export const DATA_DIR = resolve(PKG_ROOT, 'data');
export const GOLDEN_PATH = resolve(PKG_ROOT, 'golden', 'golden-v1.json');

export interface ExperimentTask {
  system: string;
  maxTokens: number;
  output_contract: string;
  parse_rule: string;
}

export interface ExperimentCondition {
  name: string;
  model: string;
}

export interface ExperimentGolden {
  path: string;
  seed: number;
  n: number;
  generator_version: number;
}

export interface Experiment {
  version: number;
  frozen_on: string;
  golden: ExperimentGolden;
  task: ExperimentTask;
  conditions: ExperimentCondition[];
  statistic: {
    primary: string;
    ci: string;
    test: string;
    bootstrap: { seed: number; iters: number };
  };
  decision_rule: string;
  ci_thresholds: { max_drop_pp: number; max_cost_increase_pct: number };
  prices: Record<string, ModelPrice>;
  spend: { cap_usd: number; expected_usd: number; ceiling_usd: number };
  headline_template: string;
  not_measured: string[];
}

export interface Protocol {
  experiment: Experiment;
  /** sha256 over the canonical golden set regenerated from the frozen seed/n. */
  goldenHash: string;
  /** sha256 over the canonical { experiment, goldenHash }. */
  hash: string;
}

export function loadExperiment(dir: string = PROTOCOL_DIR): Experiment {
  return JSON.parse(readFileSync(resolve(dir, 'experiment.json'), 'utf8')) as Experiment;
}

export function loadProtocol(dir: string = PROTOCOL_DIR): Protocol {
  const experiment = loadExperiment(dir);
  const gHash = goldenHash(generateGolden({ seed: experiment.golden.seed, n: experiment.golden.n }));
  return { experiment, goldenHash: gHash, hash: sha256Canonical({ experiment, goldenHash: gHash }) };
}

/** Regenerate the frozen golden set from the protocol (deterministic). */
export function goldenForProtocol(proto: Protocol): GoldenItem[] {
  return generateGolden({ seed: proto.experiment.golden.seed, n: proto.experiment.golden.n });
}

/** Load a committed golden file, refusing it if its hash does not match the protocol. */
export function verifyGolden(proto: Protocol, path: string = GOLDEN_PATH): GoldenItem[] {
  return loadGolden(path, { expectedHash: proto.goldenHash });
}

export interface RunState {
  protocolHash: string;
  goldenHash: string;
  protocolCommit: string | null;
  frozenAt: string | null;
  ranAt: string | null;
}

export interface AuditResult {
  ok: boolean;
  reasons: string[];
}

export interface FrozenAuditOptions {
  /**
   * The protocol commit's own timestamp (ISO 8601, e.g. from `git show -s --format=%cI <sha>`),
   * supplied by a caller that has git access. When present, the audit enforces the spec's literal
   * "commit precedes ranAt" invariant against the commit itself; when absent (offline), the
   * `frozenAt` timestamp below stands in as the proxy.
   */
  commitAt?: string | null;
}

/**
 * protocol-frozen audit: the run-state's protocol/golden hashes must match the current
 * protocol, and the protocol must have been committed/frozen no later than the run (a protocol
 * edited after data collection is a failure). The literal "commit precedes the run" check runs
 * only when the commit timestamp is supplied via `opts.commitAt`; offline, `frozenAt` is the
 * proxy for it.
 */
export function protocolFrozenAudit(proto: Protocol, state: RunState, opts: FrozenAuditOptions = {}): AuditResult {
  const reasons: string[] = [];
  if (state.protocolHash !== proto.hash) reasons.push(`protocol hash drifted: run-state ${state.protocolHash.slice(0, 12)}… vs current ${proto.hash.slice(0, 12)}…`);
  if (state.goldenHash !== proto.goldenHash) reasons.push(`golden hash drifted: run-state ${state.goldenHash.slice(0, 12)}… vs current ${proto.goldenHash.slice(0, 12)}…`);
  if (opts.commitAt && state.ranAt && Date.parse(opts.commitAt) > Date.parse(state.ranAt)) {
    reasons.push(`protocol commit ${(state.protocolCommit ?? '(unknown)').slice(0, 12)}… (${opts.commitAt}) was made after the run started (${state.ranAt})`);
  }
  if (state.frozenAt && state.ranAt && Date.parse(state.frozenAt) > Date.parse(state.ranAt)) {
    reasons.push(`protocol frozen (${state.frozenAt}) after the run started (${state.ranAt})`);
  }
  if (state.ranAt && !state.frozenAt) reasons.push('run recorded but the protocol was never frozen');
  return { ok: reasons.length === 0, reasons };
}
