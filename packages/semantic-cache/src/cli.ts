#!/usr/bin/env node
// semcache CLI. Every subcommand's real work lives in an exported, pure(-ish) `cmd*`
// function that takes typed args and returns { code, json } — never touches process.argv,
// process.exit, or console — so tests call them directly with fixtures (a tmp db, a
// hand-built embeddings.json) with no network and no real model. The citty command tree at
// the bottom is a thin argv-parsing + printing shell around those functions, and only runs
// when this file is executed directly (never on import, so importing it in tests is safe).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { defineCommand, runMain } from 'citty';
import { sha256Hex, stableStringify, seededSample } from '@portfolio-builds/shared';
import { loadProtocol, PROTOCOL_DIR, DATA_DIR, PKG_ROOT } from './protocol';
import { expandParaphraseSet } from './labelset';
import { sweep, tauGrid, type SweepPoint } from './sweep';
import { buildRunMeta, type RunMeta } from './report';
import { Store, type Namespace } from './store';
import { SemanticCache } from './cache';
import { Embedder, type EmbedderLike } from './embedder';
import { exactKeyFor } from './wrapper';
import { protocolFrozenAudit, piiSweep, readmeHeadlineAudit, embeddingAuditCompare, type EmbedMeta } from './audit';

export interface CmdResult {
  code: 0 | 1 | 2;
  json: Record<string, unknown>;
}

// ---- base64 <-> Float32Array, for the committed embeddings.json ---------------------------

function float32ArrayToBase64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

function base64ToFloat32Array(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

interface EmbeddingsFile {
  /** Recorded by `embed`; absent on an embeddings.json written before this field existed. */
  protocolHash?: string;
  embeddedAt?: string;
  /** The git commit the protocol was at when embedding ran — provenance only, not load-bearing for repro/sweep. */
  protocolCommit?: string | null;
  items: { id: string; vector: string }[];
}

function loadEmbeddingsFile(path: string): Map<string, Float32Array> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as EmbeddingsFile;
  return new Map(parsed.items.map((it) => [it.id, base64ToFloat32Array(it.vector)]));
}

function loadEmbeddingsMeta(path: string): EmbedMeta | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as EmbeddingsFile;
  return { protocolHash: parsed.protocolHash ?? null, embeddedAt: parsed.embeddedAt ?? null };
}

function defaultModelCacheDir(): string {
  return resolve(PKG_ROOT, '.model-cache');
}

/** Whether the local model's weights are actually present under `cacheDir` (not just the gitignored scaffold dir). */
function isModelCached(cacheDir: string): boolean {
  return existsSync(cacheDir) && readdirSync(cacheDir, { recursive: true }).some((f) => typeof f === 'string');
}

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PKG_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ---- model fetch (the ONE sanctioned egress override) -------------------------------------

export interface ModelFetchArgs {
  protocolDir?: string;
  cacheDir?: string;
  runStateOut?: string;
}

export async function cmdModelFetchCmd(args: ModelFetchArgs): Promise<CmdResult> {
  try {
    const protocol = loadProtocol(args.protocolDir ?? PROTOCOL_DIR);
    const cacheDir = args.cacheDir ?? defaultModelCacheDir();
    const embedder = await Embedder.load({
      modelId: protocol.cacheRules.embedding.model,
      cacheDir,
      allowRemote: true,
      dtype: protocol.cacheRules.embedding.dtype,
    });
    const fingerprint = embedder.fingerprint();
    const runStatePath = args.runStateOut ?? resolve(DATA_DIR, 'run-state.json');
    writeFileSync(
      runStatePath,
      // NOTE: the absolute `cacheDir` is intentionally NOT written to committed run-state — it
      // would leak the machine home path / username. modelId + fingerprint.files are the provenance.
      stableStringify({ modelId: protocol.cacheRules.embedding.model, fingerprint, protocolHash: protocol.hash, fetchedAt: new Date().toISOString() }),
    );
    return { code: 0, json: { modelId: protocol.cacheRules.embedding.model, files: Object.keys(fingerprint.files).length } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- embed ----------------------------------------------------------------------------------

export interface EmbedArgs {
  protocolDir?: string;
  cacheDir?: string;
  out?: string;
  /** Test-only override so embed's output is byte-stable in fixtures; the real CLI stamps `new Date().toISOString()`. */
  embeddedAt?: string;
}

export async function cmdEmbedCmd(args: EmbedArgs): Promise<CmdResult> {
  try {
    const protocol = loadProtocol(args.protocolDir ?? PROTOCOL_DIR);
    const cacheDir = args.cacheDir ?? defaultModelCacheDir();
    const embedder = await Embedder.load({
      modelId: protocol.cacheRules.embedding.model,
      cacheDir,
      allowRemote: false,
      dtype: protocol.cacheRules.embedding.dtype,
    });
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const vectors = await embedder.embed(items.map((i) => i.text));
    const out = args.out ?? resolve(DATA_DIR, 'embeddings.json');
    // protocolHash + embeddedAt are what the protocol-frozen audit checks: the protocol must
    // not have changed since this run, and must have been frozen (frozen_on) no later than
    // this timestamp. protocolCommit is recorded alongside for provenance only.
    const embeddedAt = args.embeddedAt ?? new Date().toISOString();
    writeFileSync(
      out,
      stableStringify({
        protocolHash: protocol.hash,
        embeddedAt,
        protocolCommit: gitHead(),
        items: items.map((item, i) => ({ id: item.id, vector: float32ArrayToBase64(vectors[i]!) })),
      }),
    );
    return { code: 0, json: { count: items.length, out, embeddedAt } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- sweep ----------------------------------------------------------------------------------

export interface SweepArgs {
  protocolDir?: string;
  embeddingsFile: string;
  curveOut?: string;
  runMetaOut?: string;
  generatedAt?: string;
}

export async function cmdSweepCmd(args: SweepArgs): Promise<CmdResult> {
  if (!args.embeddingsFile) return { code: 2, json: { error: 'missing --embeddings' } };
  try {
    const protocol = loadProtocol(args.protocolDir ?? PROTOCOL_DIR);
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const vecs = loadEmbeddingsFile(args.embeddingsFile);
    const curve = sweep(items, vecs, protocol.cacheRules.sweep.tau_grid, true, protocol.cacheRules);
    const generatedAt = args.generatedAt ?? new Date().toISOString();
    const runMeta = buildRunMeta(curve, protocol, generatedAt);

    const curveOut = args.curveOut ?? resolve(DATA_DIR, 'curve.json');
    const runMetaOut = args.runMetaOut ?? resolve(DATA_DIR, 'run-meta.json');
    writeFileSync(curveOut, stableStringify(curve));
    writeFileSync(runMetaOut, stableStringify(runMeta));
    return { code: 0, json: { curveOut, runMetaOut, headline: runMeta.headline } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- headline ---------------------------------------------------------------------------------

export interface HeadlineArgs {
  runMetaFile: string;
}

export async function cmdHeadlineCmd(args: HeadlineArgs): Promise<CmdResult> {
  if (!args.runMetaFile) return { code: 2, json: { error: 'missing --run-meta' } };
  if (!existsSync(args.runMetaFile)) return { code: 1, json: { error: `not found: ${args.runMetaFile}` } };
  try {
    const meta = JSON.parse(readFileSync(args.runMetaFile, 'utf8')) as RunMeta;
    return { code: 0, json: { headline: meta.headline } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- repro ------------------------------------------------------------------------------------

export interface ReproArgs {
  protocolDir?: string;
  embeddingsFile: string;
  curveFile: string;
  runMetaFile: string;
}

export async function cmdReproCmd(args: ReproArgs): Promise<CmdResult> {
  if (!args.embeddingsFile || !args.curveFile || !args.runMetaFile) return { code: 2, json: { error: 'missing --embeddings, --curve, or --run-meta' } };
  try {
    const protocol = loadProtocol(args.protocolDir ?? PROTOCOL_DIR);
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const vecs = loadEmbeddingsFile(args.embeddingsFile);
    const committedCurve = JSON.parse(readFileSync(args.curveFile, 'utf8')) as SweepPoint[];
    const committedRunMeta = JSON.parse(readFileSync(args.runMetaFile, 'utf8')) as RunMeta;

    const rederivedCurve = sweep(items, vecs, protocol.cacheRules.sweep.tau_grid, true, protocol.cacheRules);
    // generatedAt is explicitly excluded from the bit-for-bit contract: reuse the committed
    // value so the comparison below is not sensitive to wall-clock time.
    const rederivedRunMeta = buildRunMeta(rederivedCurve, protocol, committedRunMeta.generatedAt);

    const curveMatch = stableStringify(rederivedCurve) === stableStringify(committedCurve);
    const runMetaMatch = stableStringify(rederivedRunMeta) === stableStringify(committedRunMeta);
    const match = curveMatch && runMetaMatch;
    return { code: match ? 0 : 1, json: { match, curveMatch, runMetaMatch } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- audit: protocol-frozen --------------------------------------------------------------------

export interface ProtocolFrozenArgs {
  protocolDir?: string;
  embeddingsFile?: string;
}

export async function cmdProtocolFrozenCmd(args: ProtocolFrozenArgs): Promise<CmdResult> {
  try {
    const protocol = loadProtocol(args.protocolDir ?? PROTOCOL_DIR);
    const embeddingsPath = args.embeddingsFile ?? resolve(DATA_DIR, 'embeddings.json');
    const embedded = loadEmbeddingsMeta(embeddingsPath);
    const result = protocolFrozenAudit(protocol, embedded);
    return { code: result.ok ? 0 : 1, json: { ok: result.ok, reasons: result.reasons } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- audit: pii-sweep --------------------------------------------------------------------------

export interface PiiSweepArgs {
  dirs?: string[];
  root?: string;
}

export async function cmdPiiSweepCmd(args: PiiSweepArgs): Promise<CmdResult> {
  try {
    const root = args.root ?? PKG_ROOT;
    const dirs = args.dirs ?? [PROTOCOL_DIR, DATA_DIR];
    const result = piiSweep(dirs, root);
    return { code: result.violations.length === 0 ? 0 : 1, json: { filesScanned: result.filesScanned, violations: result.violations } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- audit: readme-headline --------------------------------------------------------------------

export interface ReadmeHeadlineArgs {
  readmeFile?: string;
  runMetaFile?: string;
}

export async function cmdReadmeHeadlineCmd(args: ReadmeHeadlineArgs): Promise<CmdResult> {
  try {
    const readmePath = args.readmeFile ?? resolve(PKG_ROOT, 'README.md');
    const runMetaPath = args.runMetaFile ?? resolve(DATA_DIR, 'run-meta.json');
    const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : null;
    const headline = existsSync(runMetaPath) ? (JSON.parse(readFileSync(runMetaPath, 'utf8')) as RunMeta).headline : null;
    const result = readmeHeadlineAudit(readme, headline);
    return { code: result.ok ? 0 : 1, json: { ok: result.ok, reasons: result.reasons } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- audit: embedding-audit --------------------------------------------------------------------

export interface EmbeddingAuditArgs {
  protocolDir?: string;
  embeddingsFile?: string;
  cacheDir?: string;
  sampleSize?: number;
  /** Test-only injection point; the real CLI always loads the local MiniLM model. */
  embedder?: EmbedderLike;
}

export async function cmdEmbeddingAuditCmd(args: EmbeddingAuditArgs): Promise<CmdResult> {
  try {
    const cacheDir = args.cacheDir ?? defaultModelCacheDir();
    // Spec: "passes with a note when .model-cache is absent" — no weights, nothing to re-embed
    // against, so this is not a failure. An injected test embedder bypasses the real cache dir.
    if (!args.embedder && !isModelCached(cacheDir)) {
      return { code: 0, json: { ok: true, sampled: 0, note: '.model-cache is absent — nothing to re-embed against, audit passes with a note' } };
    }
    const embeddingsPath = args.embeddingsFile ?? resolve(DATA_DIR, 'embeddings.json');
    if (!existsSync(embeddingsPath)) {
      return { code: 0, json: { ok: true, sampled: 0, note: 'no embeddings.json yet — nothing to audit' } };
    }
    const protocol = loadProtocol(args.protocolDir ?? PROTOCOL_DIR);
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const textById = new Map(items.map((i) => [i.id, i.text]));
    const committed = loadEmbeddingsFile(embeddingsPath);
    const orderedCommittedIds = items.map((i) => i.id).filter((id) => committed.has(id));
    const sampleIds = seededSample(orderedCommittedIds, args.sampleSize ?? 10, protocol.paraphraseSet.seed);

    const embedder =
      args.embedder ??
      (await Embedder.load({ modelId: protocol.cacheRules.embedding.model, cacheDir, allowRemote: false, dtype: protocol.cacheRules.embedding.dtype }));
    const freshVectors = await embedder.embed(sampleIds.map((id) => textById.get(id)!));
    const samples = sampleIds.map((id, i) => ({ id, committed: committed.get(id)!, fresh: freshVectors[i]! }));

    const result = embeddingAuditCompare(samples);
    return { code: result.ok ? 0 : 1, json: { ok: result.ok, reasons: result.reasons, minCosine: result.minCosine, sampled: result.sampled } };
  } catch (err) {
    return { code: 1, json: { error: (err as Error).message } };
  }
}

// ---- stats ------------------------------------------------------------------------------------

export interface StatsArgs {
  db: string;
  tenant?: string;
  model?: string;
  system?: string;
  mock?: boolean;
}

export async function cmdStats(args: StatsArgs): Promise<CmdResult> {
  if (!args.db) return { code: 2, json: { error: 'missing --db' } };
  const store = new Store(args.db);
  try {
    if (args.tenant && args.model && args.system !== undefined) {
      const ns: Namespace = { tenant: args.tenant, model: args.model, systemSha256: sha256Hex(args.system), mock: Boolean(args.mock) };
      const entries = store.listNamespace(ns, new Date().toISOString());
      return { code: 0, json: { entries: entries.length, hits: entries.reduce((s, e) => s + e.hits, 0), events: store.countEvents() } };
    }
    return { code: 0, json: { entries: store.countEntries(), events: store.countEvents() } };
  } finally {
    store.close();
  }
}

// ---- lookup -----------------------------------------------------------------------------------

export interface LookupArgs {
  db: string;
  tenant: string;
  model: string;
  system: string;
  text: string;
  mock?: boolean;
  protocolDir?: string;
  cacheDir?: string;
  /** Test-only injection point; the real CLI always loads the local MiniLM model. */
  embedder?: EmbedderLike;
}

export async function cmdLookup(args: LookupArgs): Promise<CmdResult> {
  if (!args.db || !args.tenant || !args.model || args.system === undefined || !args.text) {
    return { code: 2, json: { error: 'missing required --db/--tenant/--model/--system-file/--text' } };
  }
  const store = new Store(args.db);
  try {
    const protocol = loadProtocol(args.protocolDir ?? PROTOCOL_DIR);
    const embedder = args.embedder ?? (await Embedder.load({ modelId: protocol.cacheRules.embedding.model, cacheDir: args.cacheDir ?? defaultModelCacheDir(), allowRemote: false }));
    const cache = new SemanticCache({ store, embedder, rules: protocol.cacheRules });
    const ns: Namespace = { tenant: args.tenant, model: args.model, systemSha256: sha256Hex(args.system), mock: Boolean(args.mock) };
    const exactKey = exactKeyFor(args.model, args.system, args.text, null);
    const result = await cache.lookup(ns, exactKey, args.text);
    return {
      code: result.decision === 'hit' ? 0 : 1,
      json: { decision: result.decision, reason: result.reason, similarity: result.similarity, response: result.entry?.response ?? null },
    };
  } finally {
    store.close();
  }
}

// ---- purge ------------------------------------------------------------------------------------

export interface PurgeArgs {
  db: string;
  tenant?: string;
  model?: string;
  system?: string;
  mock?: boolean;
}

export async function cmdPurge(args: PurgeArgs): Promise<CmdResult> {
  if (!args.db) return { code: 2, json: { error: 'missing --db' } };
  const store = new Store(args.db);
  try {
    let ns: Namespace | undefined;
    if (args.tenant && args.model && args.system !== undefined) ns = { tenant: args.tenant, model: args.model, systemSha256: sha256Hex(args.system), mock: Boolean(args.mock) };
    const purged = store.purgeExpired(new Date().toISOString(), ns);
    return { code: 0, json: { purged } };
  } finally {
    store.close();
  }
}

// ---- citty command tree (argv parsing + printing only; no logic lives here) ---------------

function printResult(res: CmdResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(res.json));
  } else {
    console.log(Object.entries(res.json).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n'));
  }
  process.exitCode = res.code;
}

const jsonFlag = { type: 'boolean' as const, description: 'Print machine-readable JSON output.' };

// citty hands back `undefined` for every unset optional flag; exactOptionalPropertyTypes
// then refuses to widen the cmd* arg types to `| undefined` just to accept that. Drop
// undefined-valued keys instead of typing them in, so an omitted flag reads as "absent"
// (falls through to the cmd*'s own default) rather than "explicitly undefined".
function compact<T extends object>(bag: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) if (v !== undefined) out[k] = v;
  return out as T;
}

const modelFetch = defineCommand({
  meta: { name: 'fetch', description: 'Download and cache the local MiniLM model (the one sanctioned egress override).' },
  args: { json: jsonFlag, 'cache-dir': { type: 'string' as const } },
  async run({ args }) {
    printResult(await cmdModelFetchCmd(compact<ModelFetchArgs>({ cacheDir: args['cache-dir'] })), Boolean(args.json));
  },
});

const model = defineCommand({
  meta: { name: 'model', description: 'Model cache management.' },
  subCommands: { fetch: modelFetch },
});

const embed = defineCommand({
  meta: { name: 'embed', description: 'Embed the paraphrase-set protocol into data/embeddings.json.' },
  args: { json: jsonFlag, 'cache-dir': { type: 'string' as const }, out: { type: 'string' as const } },
  async run({ args }) {
    printResult(await cmdEmbedCmd(compact<EmbedArgs>({ cacheDir: args['cache-dir'], out: args.out })), Boolean(args.json));
  },
});

const sweepCmd = defineCommand({
  meta: { name: 'sweep', description: 'Sweep the tau grid against committed embeddings, writing curve.json + run-meta.json.' },
  args: { json: jsonFlag, embeddings: { type: 'string' as const }, 'curve-out': { type: 'string' as const }, 'run-meta-out': { type: 'string' as const } },
  async run({ args }) {
    const embeddingsFile = (args.embeddings as string | undefined) ?? resolve(DATA_DIR, 'embeddings.json');
    printResult(
      await cmdSweepCmd(compact<SweepArgs>({ embeddingsFile, curveOut: args['curve-out'], runMetaOut: args['run-meta-out'] })),
      Boolean(args.json),
    );
  },
});

const headline = defineCommand({
  meta: { name: 'headline', description: 'Print the rendered headline from a committed run-meta.json.' },
  args: { json: jsonFlag, 'run-meta': { type: 'string' as const } },
  async run({ args }) {
    const runMetaFile = (args['run-meta'] as string | undefined) ?? resolve(DATA_DIR, 'run-meta.json');
    printResult(await cmdHeadlineCmd({ runMetaFile }), Boolean(args.json));
  },
});

const repro = defineCommand({
  meta: { name: 'repro', description: 'Re-derive curve.json + run-meta.json from committed embeddings.json and diff against what is committed.' },
  args: { json: jsonFlag, embeddings: { type: 'string' as const }, curve: { type: 'string' as const }, 'run-meta': { type: 'string' as const } },
  async run({ args }) {
    printResult(
      await cmdReproCmd({
        embeddingsFile: (args.embeddings as string | undefined) ?? resolve(DATA_DIR, 'embeddings.json'),
        curveFile: (args.curve as string | undefined) ?? resolve(DATA_DIR, 'curve.json'),
        runMetaFile: (args['run-meta'] as string | undefined) ?? resolve(DATA_DIR, 'run-meta.json'),
      }),
      Boolean(args.json),
    );
  },
});

const protocolFrozen = defineCommand({
  meta: { name: 'protocol-frozen', description: 'Audit: the committed protocol has not changed since embeddings.json was written, and was frozen no later than embeddedAt.' },
  args: { json: jsonFlag, embeddings: { type: 'string' as const } },
  async run({ args }) {
    printResult(await cmdProtocolFrozenCmd(compact<ProtocolFrozenArgs>({ embeddingsFile: args.embeddings })), Boolean(args.json));
  },
});

const piiSweepCmd = defineCommand({
  meta: { name: 'pii-sweep', description: 'Audit: every committed protocol/ + data/ JSON file is free of PII shapes.' },
  args: { json: jsonFlag },
  async run({ args }) {
    printResult(await cmdPiiSweepCmd({}), Boolean(args.json));
  },
});

const readmeHeadline = defineCommand({
  meta: { name: 'readme-headline', description: 'Audit: README.md contains the exact rendered headline from run-meta.json, byte for byte.' },
  args: { json: jsonFlag, 'run-meta': { type: 'string' as const } },
  async run({ args }) {
    printResult(await cmdReadmeHeadlineCmd(compact<ReadmeHeadlineArgs>({ runMetaFile: args['run-meta'] })), Boolean(args.json));
  },
});

const embeddingAudit = defineCommand({
  meta: { name: 'embedding-audit', description: 'Audit: re-embed 10 seeded items with the local model; cosine to committed must be >= 0.9999 (passes with a note when .model-cache is absent).' },
  args: { json: jsonFlag, embeddings: { type: 'string' as const }, 'cache-dir': { type: 'string' as const } },
  async run({ args }) {
    printResult(await cmdEmbeddingAuditCmd(compact<EmbeddingAuditArgs>({ embeddingsFile: args.embeddings, cacheDir: args['cache-dir'] })), Boolean(args.json));
  },
});

const audit = defineCommand({
  meta: { name: 'audit', description: 'Repro-adjacent audits over committed data.' },
  subCommands: { 'protocol-frozen': protocolFrozen, 'pii-sweep': piiSweepCmd, 'readme-headline': readmeHeadline, 'embedding-audit': embeddingAudit },
});

const stats = defineCommand({
  meta: { name: 'stats', description: 'Print entry/event counts for a cache database.' },
  args: { json: jsonFlag, db: { type: 'string' as const, required: true }, tenant: { type: 'string' as const }, model: { type: 'string' as const }, 'system-file': { type: 'string' as const } },
  async run({ args }) {
    const system = args['system-file'] ? readFileSync(args['system-file'] as string, 'utf8') : undefined;
    printResult(await cmdStats(compact<StatsArgs>({ db: args.db, tenant: args.tenant, model: args.model, system })), Boolean(args.json));
  },
});

const lookup = defineCommand({
  meta: { name: 'lookup', description: 'Look up one query against the cache (exact then semantic tier).' },
  args: {
    json: jsonFlag,
    db: { type: 'string' as const, required: true },
    tenant: { type: 'string' as const, required: true },
    model: { type: 'string' as const, required: true },
    'system-file': { type: 'string' as const, required: true },
    text: { type: 'string' as const, required: true },
  },
  async run({ args }) {
    const system = readFileSync(args['system-file'] as string, 'utf8');
    printResult(await cmdLookup({ db: args.db as string, tenant: args.tenant as string, model: args.model as string, system, text: args.text as string }), Boolean(args.json));
  },
});

const purge = defineCommand({
  meta: { name: 'purge', description: 'Purge expired entries from a cache database.' },
  args: { json: jsonFlag, db: { type: 'string' as const, required: true }, tenant: { type: 'string' as const } },
  async run({ args }) {
    printResult(await cmdPurge(compact<PurgeArgs>({ db: args.db, tenant: args.tenant })), Boolean(args.json));
  },
});

export const main = defineCommand({
  meta: { name: 'semcache', description: 'A cache in front of callLlm with an exact-hash tier and a local-embedding similarity tier.' },
  subCommands: { model, embed, sweep: sweepCmd, headline, repro, audit, stats, lookup, purge },
});

// Only run the CLI when this file is executed directly — importing it (as every test does)
// must never trigger argv parsing or process.exit.
const isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  void runMain(main);
}
