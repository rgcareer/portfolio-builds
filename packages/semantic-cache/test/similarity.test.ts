import { describe, it, expect } from 'vitest';
import { cosine, topK } from '../src/similarity';

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([0.6, 0.8, 0]);
    expect(cosine(a, a)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 6);
  });

  it('computes the correct cosine even when inputs are not pre-normalized (does its own magnitude division)', () => {
    // a = (3,4) has norm 5; b = (3,0) has norm 3; true cosine = (9+0)/(5*3) = 0.6
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([3, 0]);
    expect(cosine(a, b)).toBeCloseTo(0.6, 6);
    // Scaling a vector must not change the cosine against a fixed reference.
    const aScaled = new Float32Array([30, 40]);
    expect(cosine(aScaled, b)).toBeCloseTo(cosine(a, b), 6);
  });
});

describe('topK', () => {
  it('ranks candidates by cosine similarity descending and truncates to k', () => {
    const query = new Float32Array([1, 0]);
    const candidates = [
      { id: 'perp', vector: new Float32Array([0, 1]) },
      { id: 'same', vector: new Float32Array([1, 0]) },
      { id: 'close', vector: new Float32Array([1, 0.1]) },
    ];
    const ranked = topK(query, candidates, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.id).toBe('same');
    expect(ranked[1]!.id).toBe('close');
  });
});
