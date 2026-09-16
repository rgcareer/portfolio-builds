// Cosine similarity over embedding vectors. Computes the true cosine (dot / (|a|*|b|))
// rather than a bare dot product, so it is correct even when a caller hands it vectors
// that are not already unit-normalized (the committed embeddings ARE normalized at
// embed time per protocol/cache-rules.json, but the function does not rely on that).

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`cosine: dimension mismatch (${a.length} vs ${b.length})`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export interface Scored<T> {
  id: T;
  score: number;
}

/** Ranks candidates by cosine similarity to `query`, descending, truncated to `k`. */
export function topK<T>(query: Float32Array, candidates: ReadonlyArray<{ id: T; vector: Float32Array }>, k: number): Scored<T>[] {
  const scored = candidates.map((c) => ({ id: c.id, score: cosine(query, c.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}
