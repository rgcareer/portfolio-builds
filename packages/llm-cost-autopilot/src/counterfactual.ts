// Prices real traffic against the no-cache counterfactual and splits the result into the
// primary mechanism (cache — feeds the headline) and two secondary, hypothetical mechanisms
// (batch, routing — a "what this traffic could additionally save", not what happened; never
// in the headline).

import { wilsonPctStrings, type TrafficRecord, type TrafficUsage } from '@portfolio-builds/shared';
import type { Protocol } from './protocol';
import { priceUsage, noCacheCounterfactual, cheapestPricedModel } from './prices';
import { clusterBootstrap, type SessionCost } from './bootstrap';

export interface CallFinding {
  id: string;
  ts: string;
  model: string;
  session: string | null;
  sidechain: boolean;
  latencyTolerant: boolean;
  usage: TrafficUsage;
  billedUsd: number;
  noCacheUsd: number;
  savedUsd: number;
  cacheHit: boolean;
}

export interface RunMetaPct {
  savedPct: string;
  lo: string;
  hi: string;
  pRead: string;
  loR: string;
  hiR: string;
}

export interface MechanismBreakdown {
  /** Realized savings: what caching actually avoided billing (noCacheUsd - billedUsd, summed). */
  cacheUsd: number;
  /** Hypothetical: additional savings if every latencyTolerant call had also gone through Batch. */
  batchUsd: number;
  /** Hypothetical, unverified: additional savings if every call had used the cheapest priced model. */
  routingUsd: number;
  totalUsd: number;
  routingQualityUnverified: true;
}

export interface RunMeta {
  generatedAt: string;
  protocolHash: string;
  protocolCommit: string | null;
  extractedAt: string | null;
  window: { from: string; to: string };
  n: number;
  sessions: number;
  from: string;
  to: string;
  billedUsd: number;
  noCacheUsd: number;
  savedUsd: number;
  kRead: number;
  pct: RunMetaPct | null;
  mechanisms: MechanismBreakdown;
}

export interface AnalyzeOptions {
  protocolCommit: string | null;
  extractedAt: string | null;
}

export interface AnalyzeResult {
  findings: CallFinding[];
  runMeta: RunMeta;
}

function inWindow(ts: string, from: string, to: string): boolean {
  const d = ts.slice(0, 10);
  return d >= from && d <= to;
}

function toFinding(rec: TrafficRecord): CallFinding | null {
  if (!rec.usage) return null;
  let billedUsd: number;
  let noCacheUsd: number;
  try {
    billedUsd = priceUsage(rec.model, rec.usage).totalUsd;
    noCacheUsd = priceUsage(rec.model, noCacheCounterfactual(rec.usage)).totalUsd;
  } catch {
    return null; // defensively skip anything not in the verified table
  }
  return {
    id: rec.id,
    ts: rec.ts,
    model: rec.model,
    session: rec.session,
    sidechain: rec.sidechain,
    latencyTolerant: rec.latencyTolerant,
    usage: rec.usage,
    billedUsd,
    noCacheUsd,
    savedUsd: noCacheUsd - billedUsd,
    cacheHit: rec.usage.cacheRead > 0,
  };
}

/**
 * Sums billed vs. no-cache cost over the priced window, deduplicated by record id, and
 * builds the session-level bootstrap and per-call Wilson interval that back the headline.
 * `n = 0` (no traffic yet, or the salt was absent so extraction never ran) yields `pct:
 * null` — the headline generator refuses on a null pct rather than print an unmeasured number.
 */
export function analyzeTraffic(records: readonly TrafficRecord[], policy: Protocol, opts: AnalyzeOptions): AnalyzeResult {
  const { from, to } = policy.rules.window;

  const byId = new Map<string, TrafficRecord>();
  for (const rec of records) {
    if (!inWindow(rec.ts, from, to)) continue;
    if (!byId.has(rec.id)) byId.set(rec.id, rec);
  }

  const findings: CallFinding[] = [];
  for (const rec of byId.values()) {
    const f = toFinding(rec);
    if (f) findings.push(f);
  }
  findings.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const n = findings.length;
  const billedUsd = findings.reduce((s, f) => s + f.billedUsd, 0);
  const noCacheUsd = findings.reduce((s, f) => s + f.noCacheUsd, 0);
  const kRead = findings.filter((f) => f.cacheHit).length;

  // Group by session for the cluster bootstrap. A record with no session token (e.g. an
  // imported ledger row) is its own singleton group rather than being conflated with
  // unrelated calls.
  const groupMap = new Map<string, SessionCost>();
  for (const f of findings) {
    const key = f.session ?? `__no_session_${f.id}`;
    const g = groupMap.get(key) ?? { billed: 0, noCache: 0 };
    g.billed += f.billedUsd;
    g.noCache += f.noCacheUsd;
    groupMap.set(key, g);
  }
  const sessions = groupMap.size;

  let pct: RunMetaPct | null = null;
  if (n > 0) {
    const boot = clusterBootstrap([...groupMap.values()], policy.rules.bootstrap.B, policy.rules.bootstrap.seed);
    const read = wilsonPctStrings(kRead, n);
    pct = {
      savedPct: (boot.pct * 100).toFixed(1),
      lo: (boot.lo * 100).toFixed(1),
      hi: (boot.hi * 100).toFixed(1),
      pRead: read.p,
      loR: read.lo,
      hiR: read.hi,
    };
  }

  const runMeta: RunMeta = {
    generatedAt: new Date().toISOString(),
    protocolHash: policy.hash,
    protocolCommit: opts.protocolCommit,
    extractedAt: opts.extractedAt,
    window: { from, to },
    n,
    sessions,
    from,
    to,
    billedUsd,
    noCacheUsd,
    savedUsd: noCacheUsd - billedUsd,
    kRead,
    pct,
    mechanisms: byMechanism(findings),
  };

  return { findings, runMeta };
}

/**
 * Splits total savings into three additive buckets. `cache` is realized (what actually
 * happened, per policy.counterfactual.nocache); `batch` and `routing` are hypothetical
 * additional savings on top of what was billed — `batch` only for latencyTolerant calls
 * (policy.counterfactual.batch_only_if_latency_tolerant), `routing` for every call priced
 * against the cheapest model in the table (policy.counterfactual.routing_excluded_quality_
 * unverified: it assumes the cheaper model would have produced an acceptable answer, which
 * is never verified here, so it is flagged and kept out of the headline).
 */
export function byMechanism(findings: readonly CallFinding[]): MechanismBreakdown {
  let cacheUsd = 0;
  let batchUsd = 0;
  let routingUsd = 0;

  if (findings.length > 0) {
    const cheapest = cheapestPricedModel();
    for (const f of findings) {
      cacheUsd += f.savedUsd;
      if (f.latencyTolerant) {
        const batched = priceUsage(f.model, f.usage, { batch: true }).totalUsd;
        batchUsd += Math.max(0, f.billedUsd - batched);
      }
      if (f.model !== cheapest) {
        const routed = priceUsage(cheapest, f.usage).totalUsd;
        routingUsd += Math.max(0, f.billedUsd - routed);
      }
    }
  }

  return { cacheUsd, batchUsd, routingUsd, totalUsd: cacheUsd + batchUsd + routingUsd, routingQualityUnverified: true };
}
