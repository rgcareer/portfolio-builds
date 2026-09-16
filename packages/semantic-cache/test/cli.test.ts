import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdStats,
  cmdPurge,
  cmdLookup,
  cmdSweepCmd,
  cmdHeadlineCmd,
  cmdReproCmd,
  cmdProtocolFrozenCmd,
  cmdPiiSweepCmd,
  cmdReadmeHeadlineCmd,
  cmdEmbeddingAuditCmd,
} from '../src/cli';
import { Store } from '../src/store';
import { exactKeyFor } from '../src/wrapper';
import { sha256Hex, stableStringify } from '@portfolio-builds/shared';
import { loadProtocol } from '../src/protocol';
import { expandParaphraseSet } from '../src/labelset';
import { FakeEmbedder } from '../src/embedder';
import { PROTOCOL_DIR } from '../src/protocol';

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'semcache-cli-'));
  return join(dir, 'cache.db');
}

describe('cli: stats/lookup/purge (--json, exit codes)', () => {
  it('stats returns code 0 and json with entry/event counts for an empty db', async () => {
    const dbPath = tmpDbPath();
    const res = await cmdStats({ db: dbPath, tenant: 'acme', model: 'claude-opus-4-8', system: 'sys', mock: true });
    expect(res.code).toBe(0);
    expect(res.json['entries']).toBe(0);
  });

  it('lookup returns code 1 (not an error, a clean miss) when nothing is cached', async () => {
    const dbPath = tmpDbPath();
    const res = await cmdLookup({
      db: dbPath,
      tenant: 'acme',
      model: 'claude-opus-4-8',
      system: 'You are a helpful assistant.',
      text: 'Please cancel order #4471.',
      embedder: new FakeEmbedder(),
    });
    expect(res.code).toBe(1);
    expect(res.json['decision']).toBe('miss');
  });

  it('lookup returns code 0 once the same exact call has been stored', async () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    const ns = { tenant: 'acme', model: 'claude-opus-4-8', systemSha256: sha256Hex('You are a helpful assistant.'), mock: false };
    store.insertEntry({
      ...ns,
      exactKey: exactKeyFor(ns.model, 'You are a helpful assistant.', 'Please cancel order #4471.', null),
      text: 'Please cancel order #4471.',
      textSha256: sha256Hex('Please cancel order #4471.'),
      textChars: 'Please cancel order #4471.'.length,
      embedding: new Float32Array(384),
      response: 'Cancelled.',
      usage: null,
      createdAt: '2026-09-15T00:00:00.000Z',
      expiresAt: null,
    });
    store.close();

    const res = await cmdLookup({
      db: dbPath,
      tenant: 'acme',
      model: 'claude-opus-4-8',
      system: 'You are a helpful assistant.',
      text: 'Please cancel order #4471.',
      embedder: new FakeEmbedder(),
    });
    expect(res.code).toBe(0);
    expect(res.json['decision']).toBe('hit');
  });

  it('purge returns code 0 with the number of entries removed', async () => {
    const dbPath = tmpDbPath();
    const res = await cmdPurge({ db: dbPath });
    expect(res.code).toBe(0);
    expect(res.json['purged']).toBe(0);
  });

  it('stats returns code 2 when db path is missing', async () => {
    // @ts-expect-error -- deliberately malformed args to exercise the usage-error path
    const res = await cmdStats({ tenant: 'acme' });
    expect(res.code).toBe(2);
  });
});

describe('cli: sweep/headline/repro against a fixture embeddings file (no network, no real model)', () => {
  it('sweep -> headline -> repro round-trips bit-for-bit from a committed embeddings.json shape', async () => {
    const protocol = loadProtocol(PROTOCOL_DIR);
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const embedder = new FakeEmbedder();
    const vectors = await embedder.embed(items.map((i) => i.text));

    const dir = mkdtempSync(join(tmpdir(), 'semcache-sweep-'));
    const embeddingsFile = join(dir, 'embeddings.json');
    const curveFile = join(dir, 'curve.json');
    const runMetaFile = join(dir, 'run-meta.json');
    writeFileSync(
      embeddingsFile,
      JSON.stringify({
        items: items.map((item, i) => ({ id: item.id, vector: Buffer.from(vectors[i]!.buffer).toString('base64') })),
      }),
    );

    const sweepRes = await cmdSweepCmd({ protocolDir: PROTOCOL_DIR, embeddingsFile, curveOut: curveFile, runMetaOut: runMetaFile, generatedAt: '2026-09-15T00:00:00.000Z' });
    expect(sweepRes.code).toBe(0);

    const headlineRes = await cmdHeadlineCmd({ runMetaFile });
    expect(headlineRes.code).toBe(0);
    expect(typeof headlineRes.json['headline']).toBe('string');

    const reproRes = await cmdReproCmd({ protocolDir: PROTOCOL_DIR, embeddingsFile, curveFile, runMetaFile });
    expect(reproRes.code).toBe(0);
    expect(reproRes.json['match']).toBe(true);
  });
});

describe('cli: audit commands (protocol-frozen, pii-sweep, readme-headline, embedding-audit)', () => {
  it('protocol-frozen passes trivially when no embeddings.json exists at the given path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-'));
    const res = await cmdProtocolFrozenCmd({ protocolDir: PROTOCOL_DIR, embeddingsFile: join(dir, 'embeddings.json') });
    expect(res.code).toBe(0);
    expect(res.json['ok']).toBe(true);
  });

  it('protocol-frozen passes when the committed embeddings.json records the current protocol hash and a valid embeddedAt', async () => {
    const protocol = loadProtocol(PROTOCOL_DIR);
    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-'));
    const embeddingsFile = join(dir, 'embeddings.json');
    writeFileSync(embeddingsFile, stableStringify({ protocolHash: protocol.hash, embeddedAt: '2026-09-16T00:00:00.000Z', items: [] }));
    const res = await cmdProtocolFrozenCmd({ protocolDir: PROTOCOL_DIR, embeddingsFile });
    expect(res.code).toBe(0);
    expect(res.json['ok']).toBe(true);
  });

  it('protocol-frozen fails when embeddings.json records a stale protocol hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-'));
    const embeddingsFile = join(dir, 'embeddings.json');
    writeFileSync(embeddingsFile, stableStringify({ protocolHash: 'stale-hash', embeddedAt: '2026-09-16T00:00:00.000Z', items: [] }));
    const res = await cmdProtocolFrozenCmd({ protocolDir: PROTOCOL_DIR, embeddingsFile });
    expect(res.code).toBe(1);
    expect(res.json['ok']).toBe(false);
  });

  it('pii-sweep passes over the real committed protocol/ + data/ directories', async () => {
    const res = await cmdPiiSweepCmd({});
    expect(res.code).toBe(0);
    expect(res.json['violations']).toEqual([]);
  });

  it('pii-sweep fails and reports the offending file when a committed JSON file contains PII', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-pii-'));
    writeFileSync(join(dir, 'leak.json'), JSON.stringify({ contact: 'someone@example.com' }));
    const res = await cmdPiiSweepCmd({ dirs: [dir], root: dir });
    expect(res.code).toBe(1);
    expect((res.json['violations'] as unknown[]).length).toBe(1);
  });

  it('readme-headline passes trivially when README.md / run-meta.json do not exist yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-readme-'));
    const res = await cmdReadmeHeadlineCmd({ readmeFile: join(dir, 'README.md'), runMetaFile: join(dir, 'run-meta.json') });
    expect(res.code).toBe(0);
    expect(res.json['ok']).toBe(true);
  });

  it('readme-headline fails when the README is missing the exact rendered headline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-readme-'));
    const readmeFile = join(dir, 'README.md');
    const runMetaFile = join(dir, 'run-meta.json');
    writeFileSync(readmeFile, '# semcache\n\nA cache thing, roughly 90% accurate.\n');
    writeFileSync(runMetaFile, stableStringify({ headline: 'On 280 hand-written queries, the cache served 200 of 200 (100%).' }));
    const res = await cmdReadmeHeadlineCmd({ readmeFile, runMetaFile });
    expect(res.code).toBe(1);
    expect(res.json['ok']).toBe(false);
  });

  it('readme-headline passes when the README contains the exact rendered headline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-readme-'));
    const readmeFile = join(dir, 'README.md');
    const runMetaFile = join(dir, 'run-meta.json');
    const headline = 'On 280 hand-written queries, the cache served 200 of 200 (100%).';
    writeFileSync(readmeFile, `# semcache\n\n${headline}\n`);
    writeFileSync(runMetaFile, stableStringify({ headline }));
    const res = await cmdReadmeHeadlineCmd({ readmeFile, runMetaFile });
    expect(res.code).toBe(0);
    expect(res.json['ok']).toBe(true);
  });

  it('embedding-audit passes with a note when .model-cache is absent and no embedder is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-embed-'));
    const res = await cmdEmbeddingAuditCmd({ cacheDir: join(dir, 'no-such-model-cache') });
    expect(res.code).toBe(0);
    expect(res.json['ok']).toBe(true);
    expect(res.json['note']).toMatch(/model-cache is absent/);
  });

  it('embedding-audit passes when a seeded sample re-embeds to the same vectors already committed', async () => {
    const protocol = loadProtocol(PROTOCOL_DIR);
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const embedder = new FakeEmbedder();
    const sample = items.slice(0, 15);
    const vectors = await embedder.embed(sample.map((i) => i.text));

    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-embed-'));
    const embeddingsFile = join(dir, 'embeddings.json');
    writeFileSync(
      embeddingsFile,
      JSON.stringify({ items: sample.map((item, i) => ({ id: item.id, vector: Buffer.from(vectors[i]!.buffer).toString('base64') })) }),
    );

    const res = await cmdEmbeddingAuditCmd({ protocolDir: PROTOCOL_DIR, embeddingsFile, embedder: new FakeEmbedder() });
    expect(res.code).toBe(0);
    expect(res.json['ok']).toBe(true);
    expect(res.json['sampled']).toBe(10);
  });

  it('embedding-audit fails when a committed vector does not match what the local model re-embeds', async () => {
    const protocol = loadProtocol(PROTOCOL_DIR);
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const embedder = new FakeEmbedder();
    const sample = items.slice(0, 15);
    // Commit vectors for UNRELATED text so every re-embedded id mismatches its committed
    // vector, regardless of which subset the audit's seeded sample happens to pick.
    const vectors = await embedder.embed(sample.map((_, i) => `an unrelated sentence number ${i} about the weather`));

    const dir = mkdtempSync(join(tmpdir(), 'semcache-audit-embed-'));
    const embeddingsFile = join(dir, 'embeddings.json');
    writeFileSync(
      embeddingsFile,
      JSON.stringify({ items: sample.map((item, i) => ({ id: item.id, vector: Buffer.from(vectors[i]!.buffer).toString('base64') })) }),
    );

    const res = await cmdEmbeddingAuditCmd({ protocolDir: PROTOCOL_DIR, embeddingsFile, embedder: new FakeEmbedder() });
    expect(res.code).toBe(1);
    expect(res.json['ok']).toBe(false);
  });
});
