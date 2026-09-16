// cachedCallLlm: drop-in front for callLlm. Non-cacheable specs bypass straight through
// (tool use, streaming, time-sensitive, PII, ...). Cacheable specs check the exact tier,
// then the semantic tier, before ever reaching the real (or mocked) LLM call — and on a
// miss, a successful (non-error) result is stored for next time. Every call emits a
// content-free TrafficRecord (source: 'semantic-cache') carrying the cache decision and,
// on a hit, the usage that call avoided spending.

import {
  callLlm,
  sha256Hex,
  sha256Canonical,
  emptyUsage,
  type GatewayOptions,
  type LlmResult,
  type TrafficRecord,
  type TrafficCacheInfo,
  type TrafficUsage,
} from '@portfolio-builds/shared';
import { isCacheable, type CacheableSpec } from './cacheable';
import { SemanticCache } from './cache';
import type { Namespace, EntryUsage } from './store';

export interface CachedCallOptions extends GatewayOptions {
  cache: SemanticCache;
  /** Defaults to 'default' when omitted — every namespace still separates by model/system/mock. */
  tenant?: string;
}

export interface CachedCallResult {
  result: LlmResult;
  record: TrafficRecord;
}

let seq = 0;

/** The canonical exact-tier cache key: a hash of everything that must match verbatim. */
export function exactKeyFor(model: string, system: string, user: string, maxTokens: number | null = null): string {
  return sha256Canonical({ model, system, user, maxTokens });
}

function usageToTraffic(usage: EntryUsage | null): TrafficUsage | null {
  if (!usage) return null;
  return {
    input: usage.input ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheCreation5m: usage.cacheCreation ?? 0,
    cacheCreation1h: 0,
    output: usage.output ?? 0,
  };
}

function buildRecord(spec: CacheableSpec, model: string, mock: boolean, cacheInfo: TrafficCacheInfo): TrafficRecord {
  const ts = new Date().toISOString();
  return {
    v: 1,
    id: sha256Hex(`${ts}|${model}|semantic-cache|${seq++}`).slice(0, 16),
    ts,
    source: 'semantic-cache',
    provider: 'anthropic',
    model,
    purpose: null,
    runId: null,
    tenant: null,
    tags: {},
    latencyTolerant: false,
    session: null,
    sidechain: false,
    systemSha256: sha256Hex(spec.system),
    systemChars: spec.system.length,
    userSha256: sha256Hex(spec.user),
    userChars: spec.user.length,
    usage: null,
    mock,
    error: null,
    cache: cacheInfo,
  };
}

export async function cachedCallLlm(spec: CacheableSpec, opts: CachedCallOptions): Promise<CachedCallResult> {
  const rules = opts.cache.rules;
  const model = spec.model || opts.env?.['ANTHROPIC_MODEL'] || 'claude-opus-4-8';
  const tenant = opts.tenant ?? 'default';
  const { cacheable, reason } = isCacheable(spec, rules);

  if (!cacheable) {
    const result = await callLlm(spec, opts);
    const record = buildRecord(spec, model, Boolean(opts.mock), { decision: 'bypass', reason, similarity: null, avoidedUsage: null });
    return { result, record };
  }

  const ns: Namespace = { tenant, model, systemSha256: sha256Hex(spec.system), mock: Boolean(opts.mock) };
  const exactKey = exactKeyFor(model, spec.system, spec.user, spec.maxTokens ?? null);

  const lookup = await opts.cache.lookup(ns, exactKey, spec.user);
  if (lookup.decision === 'hit' && lookup.entry) {
    const avoidedUsage = usageToTraffic(lookup.entry.usage) ?? emptyUsage();
    const result: LlmResult = {
      content: lookup.entry.response,
      error: null,
      model,
      usage: null,
      costUsd: 0,
      mock: Boolean(opts.mock),
    };
    const record = buildRecord(spec, model, Boolean(opts.mock), { decision: 'hit', reason: lookup.reason, similarity: lookup.similarity, avoidedUsage });
    return { result, record };
  }

  const result = await callLlm(spec, opts);
  if (result.error === null && result.content !== null) {
    await opts.cache.store(ns, exactKey, spec.user, result.content, result.usage);
  }
  const record = buildRecord(spec, model, Boolean(opts.mock), { decision: 'miss', reason: lookup.reason, similarity: lookup.similarity, avoidedUsage: null });
  return { result, record };
}
