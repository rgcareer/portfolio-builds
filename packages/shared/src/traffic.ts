// TrafficRecord: the shared, content-free capture format for one LLM call. Both the cost
// autopilot (which prices real traffic) and the semantic cache (which records hits) emit
// these. A record never carries prompt or response text and never a raw UUID — only hashes,
// lengths, token counts, timestamps, and HMAC tokens — so `assertNoPii` passes on any
// committed JSONL of them and a reviewer can verify no content leaks.
//
// The gateway appends one record per call when a capture sink is supplied (or when
// PB_TRAFFIC_LOG names a file). Downstream tools read them back with readTrafficJsonl.

import { appendFileSync } from 'node:fs';
import { stableStringifyLine } from './stableJson';

export type TrafficSource = 'gateway' | 'ledger' | 'claude-code' | 'semantic-cache';
export type CacheDecision = 'hit' | 'miss' | 'bypass';

export interface TrafficUsage {
  input: number;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  output: number;
}

export interface TrafficCacheInfo {
  decision: CacheDecision;
  reason: string;
  similarity: number | null;
  /** Usage that a cache hit avoided spending (valued by the cost autopilot). */
  avoidedUsage: TrafficUsage | null;
}

export interface TrafficRecord {
  v: 1;
  /** sha256(ts|model|seq)[:16] — stable, never a UUID. */
  id: string;
  /** ISO-8601 timestamp (or a coarser bucket); no sub-record precision required. */
  ts: string;
  source: TrafficSource;
  provider: string;
  model: string;
  purpose: string | null;
  runId: string | null;
  tenant: string | null;
  tags: Record<string, string>;
  latencyTolerant: boolean;
  /** HMAC session token or null; never a raw session id. */
  session: string | null;
  sidechain: boolean;
  systemSha256: string | null;
  systemChars: number | null;
  userSha256: string | null;
  userChars: number | null;
  usage: TrafficUsage | null;
  mock: boolean;
  error: string | null;
  cache: TrafficCacheInfo | null;
}

export interface TrafficSink {
  append(record: TrafficRecord): void;
}

/** An append-only JSONL sink. Never throws on write failure: capture must not break a call. */
export class JsonlTrafficSink implements TrafficSink {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  append(record: TrafficRecord): void {
    try {
      appendFileSync(this.path, stableStringifyLine(record));
    } catch {
      /* capture is best-effort; a failed write never breaks the call it describes */
    }
  }
}

/** An in-memory sink for tests and for buffering before a single flush. */
export class MemoryTrafficSink implements TrafficSink {
  readonly records: TrafficRecord[] = [];
  append(record: TrafficRecord): void {
    this.records.push(record);
  }
}

const USAGE_KEYS: (keyof TrafficUsage)[] = ['input', 'cacheRead', 'cacheCreation5m', 'cacheCreation1h', 'output'];

function isFiniteNonNegInt(x: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

function validateUsage(u: unknown, path: string, issues: string[]): void {
  if (u === null) return;
  if (typeof u !== 'object') {
    issues.push(`${path}: usage must be an object or null`);
    return;
  }
  const o = u as Record<string, unknown>;
  for (const k of USAGE_KEYS) if (!isFiniteNonNegInt(o[k])) issues.push(`${path}.${k}: must be a non-negative number`);
}

/** Returns a list of problems; empty means valid. Never throws. */
export function validateTrafficRecord(rec: unknown): string[] {
  const issues: string[] = [];
  if (rec === null || typeof rec !== 'object') return ['record must be an object'];
  const r = rec as Record<string, unknown>;
  if (r['v'] !== 1) issues.push('v: must be 1');
  if (typeof r['id'] !== 'string' || (r['id'] as string).length === 0) issues.push('id: must be a non-empty string');
  if (typeof r['ts'] !== 'string') issues.push('ts: must be a string');
  if (!['gateway', 'ledger', 'claude-code', 'semantic-cache'].includes(r['source'] as string)) issues.push('source: invalid');
  if (typeof r['model'] !== 'string') issues.push('model: must be a string');
  if (typeof r['mock'] !== 'boolean') issues.push('mock: must be a boolean');
  for (const k of ['systemSha256', 'userSha256', 'session', 'purpose', 'runId', 'tenant', 'error'] as const) {
    const v = r[k];
    if (v !== null && typeof v !== 'string') issues.push(`${k}: must be a string or null`);
  }
  validateUsage(r['usage'], 'usage', issues);
  return issues;
}

/** Parse a JSONL blob into records, skipping blank lines. Throws on a malformed line. */
export function readTrafficJsonl(text: string): TrafficRecord[] {
  const out: TrafficRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`readTrafficJsonl: malformed JSON on line ${i + 1}`);
    }
    const issues = validateTrafficRecord(obj);
    if (issues.length > 0) throw new Error(`readTrafficJsonl: invalid record on line ${i + 1}: ${issues.join('; ')}`);
    out.push(obj as TrafficRecord);
  }
  return out;
}

/** A zeroed usage object; convenient for callers building records incrementally. */
export function emptyUsage(): TrafficUsage {
  return { input: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0, output: 0 };
}
