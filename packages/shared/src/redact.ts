// HMAC-based anonymization. A token is stable for a given (salt, value) pair, so joins
// across a snapshot survive redaction, and it is unrecoverable without the salt, which is
// never committed and never published.
//
// Provenance: the placeholderId pattern from skillcheck/packages/publish/src/redact.ts,
// generalized 2026-09-10.

import { createHmac } from 'node:crypto';

export const SALT_ENV = 'PB_ANON_SALT';

/** The salt from the environment. Throws when unset: there is deliberately no default. */
export function requireSalt(env: NodeJS.ProcessEnv = process.env): string {
  const s = env[SALT_ENV];
  if (!s || s.length < 16) {
    throw new Error(`${SALT_ENV} must be set to at least 16 characters (never commit it, never publish it)`);
  }
  return s;
}

/** `${prefix}${hex}` where hex is the first `len` hex chars of HMAC-SHA256(salt, value). */
export function hmacToken(salt: string, value: string, prefix = '', len = 8): string {
  return prefix + createHmac('sha256', salt).update(value, 'utf8').digest('hex').slice(0, len);
}

/** A tokenizer bound to one salt, with a memo so repeated values map identically and fast. */
export function makeTokenizer(salt: string, prefix = '', len = 8): (value: string) => string {
  const memo = new Map<string, string>();
  return (value: string) => {
    const hit = memo.get(value);
    if (hit) return hit;
    const t = hmacToken(salt, value, prefix, len);
    memo.set(value, t);
    return t;
  };
}
