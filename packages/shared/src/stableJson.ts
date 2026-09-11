// Determinism-critical helpers. Everything that touches published or repro output routes
// through these so bit-for-bit reproducibility cannot fork on serialization, number
// formatting, ordering, or path encoding.
//
// Provenance: vendored 2026-09-10 from skillcheck/packages/core/src/stableJson.ts.

import { createHash } from 'node:crypto';

/** Recursively sort object keys; arrays are preserved in caller-provided order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

/** Canonical JSON: sorted keys, 2-space indent, LF newlines, trailing newline, no BOM. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + '\n';
}

export function sha256Hex(input: string | Uint8Array): string {
  const h = createHash('sha256');
  if (typeof input === 'string') h.update(input, 'utf8');
  else h.update(input);
  return h.digest('hex');
}

/** sha256 over the canonical serialization of a value (order-independent). */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/**
 * Percentage to `decimals` places, computed in integer space through one helper so
 * formatting can never fork between call sites. Returns 0 when the denominator is 0.
 */
export function pct(numerator: number, denominator: number, decimals = 1): number {
  if (denominator === 0) return 0;
  const scale = 10 ** decimals;
  return Math.round((100 * scale * numerator) / denominator) / scale;
}

/** Bytewise string comparison matching SQLite's BINARY collation (UTF-8 byte order). */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Normalize a PATH to NFC before sorting/hashing. File CONTENTS are never normalized. */
export function normalizePathNfc(p: string): string {
  return p.normalize('NFC');
}
