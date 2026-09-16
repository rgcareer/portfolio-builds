// Redaction primitives shared by the adapters and the audit. Everything an agent-forensics
// RunRecord carries is produced by one of these helpers, so a record is redacted BY
// CONSTRUCTION: the only strings that can appear are HMAC tokens/hashes, ISO timestamps,
// small enums, counts, and version-shaped identifiers. There is no code path that copies a
// prompt, a tool input, a tool output, a file path, or any other free text into a record.

import { hmacToken, makeTokenizer } from '@portfolio-builds/shared';
import type { MetaScalar } from '@portfolio-builds/shared';
import type { Protocol } from './protocol';

/** A bundle of salt-bound hashers for one ingest, so joins survive but values do not. */
export interface Tokenizers {
  /** `s_<8hex>` for session ids. */
  session: (v: string) => string;
  /** `p_<8hex>` for filesystem paths (cwd). */
  path: (v: string) => string;
  /** `other:<8hex>` component for non-first-party tool names. */
  tool8: (v: string) => string;
  /** `c_<8hex>` for tool-call ids (raw ids never stored). */
  call: (v: string) => string;
  /** 16-hex content hash for text / tool input / tool output (unrecoverable, joinable). */
  hash: (v: string) => string;
  /** 16-hex hash for a git branch name. */
  branch: (v: string) => string;
}

export function makeTokenizers(salt: string): Tokenizers {
  const session = makeTokenizer(salt, 's_', 8);
  const path = makeTokenizer(salt, 'p_', 8);
  const tool8 = makeTokenizer(salt, '', 8);
  const call = makeTokenizer(salt, 'c_', 8);
  return {
    session,
    path,
    tool8,
    call,
    hash: (v: string) => hmacToken(salt, v, '', 16),
    branch: (v: string) => hmacToken(salt, v, '', 16),
  };
}

/**
 * Keep a `toolUseResult` field ONLY when its key is on the allowlist and its value is a
 * permitted scalar shape. Returns the value to keep, or `undefined` to drop it. Everything
 * else — stdout, stderr, command, content, file histories — is dropped by omission.
 */
export function keepScalar(key: string, value: unknown, protocol: Protocol): MetaScalar | undefined {
  if (!protocol.keptKeys.has(key)) return undefined;
  if (key === 'status') {
    return typeof value === 'string' && protocol.statusRe.test(value) ? value : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

/**
 * Classify raw error text into ONE frozen label by the protocol regexes, in the frozen
 * order. Only the label is ever emitted; the raw text is never returned or stored.
 */
export function errorClassOf(raw: unknown, protocol: Protocol): string {
  const s = String(raw ?? '').toLowerCase();
  for (const { label, re } of protocol.errorClassRegexes) {
    if (re.test(s)) return label;
  }
  return protocol.errorClassFallback;
}

/**
 * A first-party tool name passes through verbatim (it is an allowlisted enum); anything else
 * — including every `mcp__*` server tool — becomes `other:<8hex>`, so the fact that a tool
 * ran is preserved while the tool's identity is not.
 */
export function toolNameOf(raw: unknown, protocol: Protocol, tokenizers: Tokenizers): string {
  const name = typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
  if (protocol.firstPartyTools.has(name)) return name;
  if (name === 'unknown') return 'unknown';
  return 'other:' + tokenizers.tool8(name);
}
