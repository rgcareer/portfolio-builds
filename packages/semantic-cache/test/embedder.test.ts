import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { FakeEmbedder } from '../src/embedder';
import { Embedder } from '../src/embedder';
import { PKG_ROOT } from '../src/protocol';
import { resolve } from 'node:path';
import { cosine } from '../src/similarity';

describe('FakeEmbedder (deterministic unit vector for tests)', () => {
  it('embeds to unit-norm vectors of a fixed dimension', async () => {
    const e = new FakeEmbedder();
    const [v] = await e.embed(['hello world']);
    expect(v).toBeInstanceOf(Float32Array);
    let norm = 0;
    for (const x of v!) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('is deterministic: same text embeds to the same vector across calls', async () => {
    const e = new FakeEmbedder();
    const [a] = await e.embed(['Please cancel order #4471.']);
    const [b] = await e.embed(['Please cancel order #4471.']);
    expect(Array.from(a!)).toEqual(Array.from(b!));
  });

  it('gives shared-vocabulary texts higher cosine similarity than unrelated texts', async () => {
    const e = new FakeEmbedder();
    const [base, para, unrelated] = await e.embed([
      'Please cancel order #4471.',
      'Can you cancel order #4471 for me?',
      'Please renew the certificate for api.example.internal.',
    ]);
    expect(cosine(base!, para!)).toBeGreaterThan(cosine(base!, unrelated!));
  });

  it('tracks how many texts have been embedded (so callers can assert exact-tier hits skip embedding)', async () => {
    const e = new FakeEmbedder();
    expect(e.embedCount).toBe(0);
    await e.embed(['a', 'b', 'c']);
    expect(e.embedCount).toBe(3);
  });
});

const modelCacheDir = resolve(PKG_ROOT, '.model-cache');
// The directory itself is a committed-empty scaffold (see .gitignore); only treat the model
// as cached once it actually has files under it (the real gate main session's `model fetch`
// populates it — the ONE egress override — this package never fetches on its own).
const modelCached = existsSync(modelCacheDir) && readdirSync(modelCacheDir, { recursive: true }).some((f) => typeof f === 'string');

describe.skipIf(!modelCached)('Embedder (real MiniLM model, only when .model-cache is populated)', () => {
  it('embeds to 384-dimensional vectors', async () => {
    const embedder = await Embedder.load({ modelId: 'Xenova/all-MiniLM-L6-v2', cacheDir: modelCacheDir, allowRemote: false });
    const [v] = await embedder.embed(['hello world']);
    expect(v!.length).toBe(384);
  });

  it('embeds to unit-norm vectors', async () => {
    const embedder = await Embedder.load({ modelId: 'Xenova/all-MiniLM-L6-v2', cacheDir: modelCacheDir, allowRemote: false });
    const [v] = await embedder.embed(['hello world']);
    let norm = 0;
    for (const x of v!) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
  });

  it('is deterministic across two calls', async () => {
    const embedder = await Embedder.load({ modelId: 'Xenova/all-MiniLM-L6-v2', cacheDir: modelCacheDir, allowRemote: false });
    const [a] = await embedder.embed(['hello world']);
    const [b] = await embedder.embed(['hello world']);
    expect(Array.from(a!)).toEqual(Array.from(b!));
  });

  it('produces a fingerprint with a per-file sha256', async () => {
    const embedder = await Embedder.load({ modelId: 'Xenova/all-MiniLM-L6-v2', cacheDir: modelCacheDir, allowRemote: false });
    const fp = embedder.fingerprint();
    expect(fp.modelId).toBe('Xenova/all-MiniLM-L6-v2');
    expect(Object.keys(fp.files).length).toBeGreaterThan(0);
    for (const hash of Object.values(fp.files)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
