// Independent redaction audit. redactionAudit walks any JSON value and flags anything that
// would breach the privacy guarantee: PII/secret shapes, forbidden keys (raw text sinks),
// absolute-path shapes, and over-long strings (free text). auditTree applies it to every
// committed *.json under a set of directories and additionally flags files that are not
// RunRecords. protocolFrozen checks that the committed protocol still matches what the run
// was collected under, and that the protocol commit predates ingest.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { findPii, validateRunRecord, isTokenShaped } from '@portfolio-builds/shared';
import type { Protocol } from './protocol';

export interface Violation {
  path: string;
  kind: 'pii' | 'forbidden-key' | 'path-shape' | 'long-string' | 'bad-id' | 'not-run-record' | 'parse-error';
  detail: string;
}

const PATH_SHAPES: RegExp[] = [
  /\/Users\//,
  /\/home\/[A-Za-z0-9]/,
  /~\//,
  /[A-Za-z]:\\/,
  /(^|[^A-Za-z0-9])\/(?:etc|var|tmp|opt|usr|bin|root|private)\//,
  /^(?:\/[A-Za-z0-9._-]+){2,}\/?$/,
];

const MAX_STRING = 64;

function looksLikeId(key: string): boolean {
  return /(^|[A-Z_])(id|Id|ID|token|Token|hash|Hash|uuid|Uuid)$/.test(key) || key === 'runId';
}

/** Flag every privacy breach reachable from `value`. Empty array means clean. */
export function redactionAudit(value: unknown, protocol: Protocol): Violation[] {
  const out: Violation[] = [];
  // Content-sink keys that must NEVER appear in a RunRecord. Derived from the protocol's
  // never-kept list, minus `input`/`output` — those are legitimate RunUsage field names, so
  // a raw `input`/`output` text sink is caught by the PII / long-string / path checks instead.
  const forbidden = new Set([...protocol.neverKept].filter((k) => k !== 'input' && k !== 'output'));

  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      for (const hit of findPii(v)) out.push({ path, kind: 'pii', detail: hit.kind });
      if (PATH_SHAPES.some((re) => re.test(v))) out.push({ path, kind: 'path-shape', detail: v.slice(0, 32) });
      if (v.length > MAX_STRING) out.push({ path, kind: 'long-string', detail: `${v.length} chars` });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const childPath = path ? `${path}.${k}` : k;
        if (forbidden.has(k)) out.push({ path: childPath, kind: 'forbidden-key', detail: k });
        // An id-shaped key must carry a token/hash shape, never a raw identifier.
        if (looksLikeId(k) && typeof val === 'string' && val.length > 0 && !isTokenShaped(val) && !/^(other:[0-9a-f]{8})$/.test(val)) {
          out.push({ path: childPath, kind: 'bad-id', detail: val.slice(0, 32) });
        }
        walk(val, childPath);
      }
    }
  };

  walk(value, '');
  return out;
}

function listJson(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = resolve(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.json')) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export interface TreeAuditResult {
  filesScanned: number;
  violations: (Violation & { file: string })[];
}

// Report / run-meta / run-state / ledger files are generated artifacts, not RunRecords; they
// are still swept for PII but are not required to validate as RunRecords.
const NON_RECORD_BASENAMES = new Set(['findings.json', 'run-meta.json', 'run-state.json', 'ingest-ledger.json']);

/**
 * Sweep every committed *.json under the given dirs. record-shaped files (data/records/*,
 * fixtures/labeled/*) must validate as RunRecords; all files must survive redactionAudit.
 */
export function auditTree(dirs: string[], protocol: Protocol, root = process.cwd()): TreeAuditResult {
  const violations: (Violation & { file: string })[] = [];
  let filesScanned = 0;
  for (const dir of dirs) {
    for (const file of listJson(dir)) {
      filesScanned++;
      const rel = relative(root, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        violations.push({ file: rel, path: '', kind: 'parse-error', detail: (e as Error).message });
        continue;
      }
      for (const v of redactionAudit(parsed, protocol)) violations.push({ file: rel, ...v });
      const base = file.slice(file.lastIndexOf('/') + 1);
      const isRecordSlot = /\/records\//.test(file) || /\/labeled\//.test(file);
      if (isRecordSlot && !NON_RECORD_BASENAMES.has(base)) {
        const issues = validateRunRecord(parsed);
        if (issues.length > 0) violations.push({ file: rel, path: '', kind: 'not-run-record', detail: issues[0]!.message });
      }
    }
  }
  return { filesScanned, violations };
}

export interface RunState {
  protocolHash: string;
  protocolCommit: string | null;
  ingestedAt: string | null;
}

export interface FrozenResult {
  ok: boolean;
  reasons: string[];
}

/**
 * protocol-frozen audit: the committed protocol hash equals run-state's recorded hash, the
 * findings/run-meta both record that hash, and (when a commit + ingest time are known) the
 * protocol commit's time precedes ingestedAt. commitPrecedesIngest is supplied by the caller
 * (it knows git); left undefined it is treated as satisfied (trivially true before ingest).
 */
export function protocolFrozen(
  protocol: Protocol,
  state: RunState | null,
  opts: { runMetaHash?: string | null; findingsHash?: string | null; commitPrecedesIngest?: boolean } = {},
): FrozenResult {
  const reasons: string[] = [];
  if (!state || state.ingestedAt === null) {
    return { ok: true, reasons: ['no ingest yet — protocol-frozen passes trivially'] };
  }
  if (state.protocolHash !== protocol.hash) reasons.push(`run-state protocolHash ${state.protocolHash.slice(0, 12)} != committed ${protocol.hash.slice(0, 12)}`);
  if (opts.runMetaHash != null && opts.runMetaHash !== protocol.hash) reasons.push('run-meta protocolHash differs from committed protocol');
  if (opts.findingsHash != null && opts.findingsHash !== protocol.hash) reasons.push('findings protocolHash differs from committed protocol');
  if (opts.commitPrecedesIngest === false) reasons.push('protocol commit does not precede ingestedAt');
  return { ok: reasons.length === 0, reasons };
}
