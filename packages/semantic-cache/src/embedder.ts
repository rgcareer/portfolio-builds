// The embedding layer. `Embedder` wraps transformers.js's local MiniLM feature-extraction
// pipeline (offline once the weights are cached — see `semcache model fetch`, the one
// sanctioned egress override). `FakeEmbedder` is a bag-of-words hashing embedder used by
// every test except the embedder test itself: deterministic, dependency-free, and — because
// it hashes shared words into shared dimensions — gives near-miss negatives (which share
// almost every word with their base) a realistically high cosine similarity, so tests can
// exercise the guard tier the same way the real model does.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256Hex } from '@portfolio-builds/shared';

export interface EmbedderLike {
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ---- FakeEmbedder -------------------------------------------------------------------------

const FAKE_DIMS = 384;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class FakeEmbedder implements EmbedderLike {
  readonly dims = FAKE_DIMS;
  embedCount = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCount += texts.length;
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const words = text.toLowerCase().match(/[a-z0-9#]+/g) ?? [];
    for (const w of words) v[fnv1a(w) % this.dims]! += 1;
    let norm = 0;
    for (let i = 0; i < this.dims; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dims; i++) v[i] = v[i]! / norm;
    return v;
  }

  fingerprint(): string {
    return 'fake-embedder-v1';
  }
}

// ---- Embedder (real local MiniLM via @huggingface/transformers) -----------------------------

export interface EmbedderOptions {
  modelId: string;
  cacheDir: string;
  /** Whether the pipeline may fetch weights over the network. `model fetch` is the only step that sets this true. */
  allowRemote: boolean;
  dtype?: string;
}

export interface EmbedderFingerprint {
  modelId: string;
  cacheDir: string;
  /** relative path -> sha256 hex, one entry per cached model file. */
  files: Record<string, string>;
}

// Narrow structural type for the transformers.js feature-extraction pipeline callable —
// avoids importing its full type surface (which pulls in onnxruntime-common types) just
// for the two members this module uses.
interface FeatureExtractionCallable {
  (texts: string | string[], options?: { pooling?: string; normalize?: boolean }): Promise<{ dims: number[]; data: Float32Array | number[] }>;
}

export class Embedder implements EmbedderLike {
  private readonly extractor: FeatureExtractionCallable;
  private readonly modelId: string;
  private readonly cacheDir: string;

  private constructor(extractor: FeatureExtractionCallable, modelId: string, cacheDir: string) {
    this.extractor = extractor;
    this.modelId = modelId;
    this.cacheDir = cacheDir;
  }

  static async load(opts: EmbedderOptions): Promise<Embedder> {
    // Dynamic import: @huggingface/transformers is a heavy optional dependency that only
    // the `embed`/`model fetch` CLI paths and the (normally skipped) real-embedder test need.
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = opts.cacheDir;
    env.allowRemoteModels = opts.allowRemote;
    env.allowLocalModels = true;
    // dtype is typed as a plain string on EmbedderOptions (it round-trips through committed
    // JSON in protocol/cache-rules.json); transformers.js narrows it to its own DataType
    // union, which this cast bridges — the actual value is always one of that union's
    // members ("fp32" from the committed protocol, in practice).
    type PipelineDtype = Exclude<NonNullable<Parameters<typeof pipeline>[2]>['dtype'], undefined>;
    const dtype: PipelineDtype = (opts.dtype ?? 'fp32') as PipelineDtype;
    const extractor = (await pipeline('feature-extraction', opts.modelId, { dtype })) as unknown as FeatureExtractionCallable;
    return new Embedder(extractor, opts.modelId, opts.cacheDir);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const output = await this.extractor(texts, { pooling: 'mean', normalize: true });
    const dims = output.dims;
    const n = dims[0] ?? 0;
    const d = dims[1] ?? 0;
    const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
    const out: Float32Array[] = [];
    for (let i = 0; i < n; i++) out.push(data.slice(i * d, (i + 1) * d));
    return out;
  }

  /** Per-file sha256 over every file the model's weights were cached under, for repro audits. */
  fingerprint(): EmbedderFingerprint {
    const root = join(this.cacheDir, this.modelId);
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files[relative(root, full)] = sha256Hex(readFileSync(full));
      }
    };
    if (statSync(root, { throwIfNoEntry: false })) walk(root);
    return { modelId: this.modelId, cacheDir: this.cacheDir, files };
  }
}
