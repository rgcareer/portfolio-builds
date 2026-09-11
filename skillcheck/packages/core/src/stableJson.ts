import { createHash } from 'node:crypto';

// Determinism-critical helpers. Everything that touches published or repro output must
// route through these so bit-for-bit reproducibility cannot fork on serialization,
// number formatting, ordering, or path encoding. See plan §"Determinism".

/** Recursively sort object keys; arrays are preserved in caller-provided order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Default sort compares by UTF-16 code unit — deterministic and locale-independent.
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

/** Canonical JSON: sorted keys, 2-space indent, LF newlines, trailing newline, no BOM. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + '\n';
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** sha256 over the canonical serialization of a value (order-independent). */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/**
 * Percentage to two decimals, computed in integer space through one helper so formatting
 * can never fork between call sites. Returns 0 when the denominator is 0.
 */
export function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((10000 * numerator) / denominator) / 100;
}

/**
 * Bytewise string comparison matching SQLite's BINARY collation exactly (UTF-8 byte
 * order), so a JS-side sort and an SQL `ORDER BY` agree even for non-ASCII input.
 */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Normalize a PATH to NFC before sorting/hashing (macOS/APFS and git can disagree on
 * NFC/NFD). File CONTENTS are deliberately never normalized — the unicode rules need raw
 * codepoints.
 */
export function normalizePathNfc(p: string): string {
  return p.normalize('NFC');
}
