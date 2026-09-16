// Refusal policy: which LLM call specs are even eligible for caching. Tool-use, streaming,
// explicitly time-sensitive or opted-out calls, empty input, time-sensitive-looking text, and
// PII in the user text are all refused — never cached, never served from cache.

import { findPii, type PiiKind } from '@portfolio-builds/shared';
import type { CacheRules } from './protocol';

export interface CacheableSpec {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  tools?: unknown[];
  stream?: boolean;
  /** Explicit caller signal that this call's answer depends on wall-clock time. */
  timeSensitive?: boolean;
  /** Explicit caller opt-out. */
  noCache?: boolean;
}

export type CacheableReason =
  | 'tools'
  | 'stream'
  | 'timeSensitive'
  | 'noCache'
  | 'empty-user'
  | 'time-sensitive-text'
  | 'pii'
  | 'ok';

export interface CacheableResult {
  cacheable: boolean;
  reason: CacheableReason;
}

export function isCacheable(spec: CacheableSpec, rules: CacheRules): CacheableResult {
  if (spec.tools && spec.tools.length > 0) return { cacheable: false, reason: 'tools' };
  if (spec.stream) return { cacheable: false, reason: 'stream' };
  if (spec.timeSensitive) return { cacheable: false, reason: 'timeSensitive' };
  if (spec.noCache) return { cacheable: false, reason: 'noCache' };
  if (!spec.user || spec.user.trim() === '') return { cacheable: false, reason: 'empty-user' };

  const timeRe = new RegExp(rules.refusal.time_regex, rules.refusal.time_regex_flags);
  if (timeRe.test(spec.user)) return { cacheable: false, reason: 'time-sensitive-text' };

  const piiHits = findPii(spec.user, rules.refusal.pii_kinds as PiiKind[]);
  if (piiHits.length > 0) return { cacheable: false, reason: 'pii' };

  return { cacheable: true, reason: 'ok' };
}
