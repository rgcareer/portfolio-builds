// Audit logic: protocol-frozen, pii-sweep, readme-headline, embedding-audit — the four builder
// deliverables the spec lists alongside `repro`. Every function here is pure(-ish): it takes
// already-resolved data (a loaded protocol, parsed JSON, vectors) and returns {ok, reasons};
// the cmd* wrappers in cli.ts do the file I/O and model loading. That split mirrors the
// protocol-frozen / redaction-sweep pattern used by the other portfolio-builds packages (see
// agent-forensics/src/audit.ts's protocolFrozen + redactionAudit, and model-regress/src/
// protocol.ts's protocolFrozenAudit), so these audits are testable without touching disk or
// loading the real embedding model.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { findPii } from '@portfolio-builds/shared';
import { cosine } from './similarity';
import type { Protocol } from './protocol';

export interface AuditResult {
  ok: boolean;
  reasons: string[];
}

// ---- protocol-frozen ------------------------------------------------------------------------

/** The provenance fields `embed` commits alongside the vectors, once it has run. */
export interface EmbedMeta {
  protocolHash?: string | null;
  embeddedAt?: string | null;
}

/**
 * protocol-frozen audit: the protocol hash recorded when embeddings.json was written must
 * equal the currently-committed protocol's hash (the rules or paraphrase set were not edited
 * after embedding), and the protocol's declared `frozen_on` date must precede embeddedAt (the
 * protocol cannot have been frozen after the data it governs was already collected). This is
 * the same hash-equality + freeze-precedes-collection shape as model-regress's
 * protocolFrozenAudit; frozen_on (not a live git-log lookup) is the freeze marker there too,
 * since it is the protocol's own committed declaration of when it was frozen and does not
 * depend on the protocol files having a git history yet at audit time.
 */
export function protocolFrozenAudit(protocol: Protocol, embedded: EmbedMeta | null): AuditResult {
  if (!embedded || !embedded.protocolHash || !embedded.embeddedAt) {
    return { ok: true, reasons: ['no embeddings.json yet (or it predates protocolHash/embeddedAt) — nothing embedded, audit passes trivially'] };
  }
  const reasons: string[] = [];
  if (embedded.protocolHash !== protocol.hash) {
    reasons.push(`embeddings.json protocolHash ${embedded.protocolHash.slice(0, 12)}… != committed protocol ${protocol.hash.slice(0, 12)}… — the protocol changed after embedding`);
  }
  const frozenAt = `${protocol.cacheRules.frozen_on}T00:00:00.000Z`;
  if (Date.parse(frozenAt) > Date.parse(embedded.embeddedAt)) {
    reasons.push(`protocol frozen_on (${protocol.cacheRules.frozen_on}) is after embeddedAt (${embedded.embeddedAt}) — the protocol was frozen after the data it governs was already embedded`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ---- pii-sweep ------------------------------------------------------------------------------

export interface PiiViolation {
  file: string;
  kind: string;
  index: number;
}

export interface PiiSweepResult {
  filesScanned: number;
  violations: PiiViolation[];
}

function listJson(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = resolve(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.json')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * pii-sweep audit: every committed *.json under the given directories (protocol/ + data/ by
 * default) is scanned for PII shapes via `findPii`. This complements the labelset test's
 * `assertNoPii` over the expanded paraphrase texts — that test only ever looks at in-memory
 * expanded text, never at what actually lands in the committed embeddings/curve/run-meta
 * artifacts — so this sweep is what actually guards the files that get published.
 */
export function piiSweep(dirs: string[], root = process.cwd()): PiiSweepResult {
  const violations: PiiViolation[] = [];
  let filesScanned = 0;
  for (const dir of dirs) {
    for (const file of listJson(dir)) {
      filesScanned++;
      const rel = relative(root, file);
      const text = readFileSync(file, 'utf8');
      for (const hit of findPii(text)) violations.push({ file: rel, kind: hit.kind, index: hit.index });
    }
  }
  return { filesScanned, violations };
}

// ---- readme-headline ------------------------------------------------------------------------

/**
 * readme-headline audit: the README's prose must contain the SAME headline sentence that
 * `renderHeadline` produced from the committed run-meta.json, byte for byte — never a
 * hand-retyped or since-drifted copy of the number. Passes with a note (not a failure) when
 * either input does not exist yet: this package ships before the headline-run phase that
 * writes README.md and run-meta.json, and an audit must not fail for work that has not
 * happened yet — only for work that HAS happened and disagrees with itself.
 */
export function readmeHeadlineAudit(readme: string | null, headline: string | null): AuditResult {
  if (readme === null) return { ok: true, reasons: ['README.md not found yet — nothing to compare, audit not yet applicable'] };
  if (headline === null) return { ok: true, reasons: ['no run-meta.json yet — nothing to compare, audit not yet applicable'] };
  if (!readme.includes(headline)) {
    return { ok: false, reasons: ['README.md does not contain the exact rendered headline from run-meta.json — it is missing, stale, or was hand-typed'] };
  }
  return { ok: true, reasons: [] };
}

// ---- embedding-audit ------------------------------------------------------------------------

export interface EmbeddingAuditSample {
  id: string;
  committed: Float32Array;
  fresh: Float32Array;
}

export interface EmbeddingAuditResult extends AuditResult {
  minCosine: number | null;
  sampled: number;
}

export const EMBEDDING_AUDIT_MIN_COSINE = 0.9999;

/**
 * embedding-audit: given (id, committed-vector, freshly-re-embedded-vector) triples for a
 * seeded sample, every pair must cosine >= 0.9999 — proof that the committed embeddings.json
 * actually came from the pinned local model at the pinned dtype/pooling, not from a different
 * run or a hand-edited file. The "re-embed with the local model, or pass with a note when
 * .model-cache is absent" half of the spec's requirement is the caller's job (cmdEmbeddingAuditCmd
 * in cli.ts): it decides whether the model is available and, if not, returns ok with a note
 * without ever calling this comparison.
 */
export function embeddingAuditCompare(samples: EmbeddingAuditSample[]): EmbeddingAuditResult {
  if (samples.length === 0) return { ok: true, reasons: ['no samples to compare'], minCosine: null, sampled: 0 };
  const reasons: string[] = [];
  let minCosine = Infinity;
  for (const s of samples) {
    const c = cosine(s.committed, s.fresh);
    if (c < minCosine) minCosine = c;
    if (c < EMBEDDING_AUDIT_MIN_COSINE) reasons.push(`${s.id}: cosine ${c.toFixed(6)} < ${EMBEDDING_AUDIT_MIN_COSINE}`);
  }
  return { ok: reasons.length === 0, reasons, minCosine, sampled: samples.length };
}
