// Deterministic pseudo-randomness. mulberry32 is pure 32-bit integer arithmetic, so it
// produces an identical stream on every platform and Node version. This is the ONLY
// sanctioned source of pseudo-randomness in portfolio-builds (never Math.random).
//
// Provenance: vendored 2026-09-10 from skillcheck/packages/core/src/prng.ts.

/** mulberry32 PRNG. Returns a function yielding floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic sample of up to `n` items from an ALREADY-ORDERED array via seeded partial
 * Fisher-Yates. The input must be in a stable order; the result is a subset.
 */
export function seededSample<T>(ordered: readonly T[], n: number, seed: number): T[] {
  const arr = ordered.slice();
  const rng = mulberry32(seed);
  const count = Math.min(Math.max(n, 0), arr.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr.slice(0, count);
}
