// Failure taxonomy from logs only. Atomize multi-board error strings, normalize volatile
// tokens, group by exact template. Employer names are tokenized through a caller-supplied
// function (HMAC-bound) so this module never sees the salt and never keeps the mapping.

import { sha256Hex } from '@portfolio-builds/shared';

export interface Atom {
  /** the error record this atom came from (already-redacted id) */
  sourceId: string;
  /** board/tenant prefix if the atom came from a multi-board string, else null */
  board: string | null;
  /** the atom message, verbatim from the source (pre-normalization) */
  message: string;
}

const MULTI_BOARD_RE = /^(\d+)\/(\d+) boards failed:\s*(.*)$/s;

/**
 * Split "k/n boards failed: a: msg; b: msg" into one atom per board. Anything else is one atom.
 * A board prefix is the shortest "<token>: " before the message where the token has no spaces.
 */
export function atomize(sourceId: string, error: string): Atom[] {
  const m = MULTI_BOARD_RE.exec(error.trim());
  if (!m) return [{ sourceId, board: null, message: error.trim() }];
  const rest = m[3]!;
  const parts = rest.split(/;\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => {
    const bm = /^([^\s:]+):\s*(.*)$/s.exec(p);
    return bm ? { sourceId, board: bm[1]!, message: bm[2]!.trim() } : { sourceId, board: null, message: p };
  });
}

export type Tokenizer = (value: string) => string;

const WORKDAY_TENANT_RE = /\b[a-z0-9-]+\.wd\d+\/[A-Za-z0-9_-]+/g;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HTTP_STATUS_RE = /\b(HTTP\s+|\()(\d{3})\b/g;

/**
 * Normalize one atom into its template. Order matters: tenants and timestamps before digits.
 * `tokenizeEmployer` receives the board prefix (if any) and returns its co_ token; it is applied
 * to the board only, since messages never carry employer names except as tenants (tokenized).
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(WORKDAY_TENANT_RE, '<tenant>')
    .replace(ISO_TS_RE, '<ts>')
    .replace(UUID_RE, '<uuid>')
    .replace(HTTP_STATUS_RE, (_m, pre: string, code: string) => `${pre}${code}`) // keep status codes literal
    .replace(/(?<![A-Za-z(])\b\d+\b(?![A-Za-z])/g, (m, offset: number, s: string) => {
      // keep a 3-digit code that directly follows "HTTP " or "(" (already protected above)
      const before = s.slice(Math.max(0, offset - 6), offset);
      return /HTTP\s+$|\($/.test(before) ? m : '<n>';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Templated {
  atom: Atom;
  boardToken: string | null;
  template: string;
  clusterId: string;
}

export function templatize(atom: Atom, tokenizeEmployer: Tokenizer): Templated {
  const template = normalizeMessage(atom.message);
  return {
    atom,
    boardToken: atom.board ? tokenizeEmployer(atom.board) : null,
    template,
    clusterId: sha256Hex(template).slice(0, 8),
  };
}

export interface Cluster {
  clusterId: string;
  template: string;
  count: number;
  /** distinct source records */
  records: number;
  /** distinct employer tokens seen with this template (count only) */
  employerTokens: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** two redacted example messages (pre-normalization, employer-tokenized) */
  examples: string[];
}

export function cluster(items: { t: Templated; at: string | null }[]): Cluster[] {
  const map = new Map<string, Cluster & { _records: Set<string>; _emp: Set<string> }>();
  for (const { t, at } of items) {
    let c = map.get(t.clusterId);
    if (!c) {
      c = { clusterId: t.clusterId, template: t.template, count: 0, records: 0, employerTokens: 0, firstSeen: null, lastSeen: null, examples: [], _records: new Set(), _emp: new Set() };
      map.set(t.clusterId, c);
    }
    c.count++;
    c._records.add(t.atom.sourceId);
    if (t.boardToken) c._emp.add(t.boardToken);
    if (at) {
      if (!c.firstSeen || at < c.firstSeen) c.firstSeen = at;
      if (!c.lastSeen || at > c.lastSeen) c.lastSeen = at;
    }
    if (c.examples.length < 2) {
      const ex = (t.boardToken ? `${t.boardToken}: ` : '') + t.atom.message.replace(WORKDAY_TENANT_RE, '<tenant>');
      if (!c.examples.includes(ex)) c.examples.push(ex);
    }
  }
  return [...map.values()]
    .map(({ _records, _emp, ...c }) => ({ ...c, records: _records.size, employerTokens: _emp.size }))
    .sort((a, b) => b.count - a.count || (a.template < b.template ? -1 : 1));
}

/** Operator annotations are not agent failures; they are human cleanups and are counted apart. */
export function isOperatorAnnotation(message: string): boolean {
  return /crash orphan|stale\/aborted run|cleaned up|closed by .*(audit|purge)/i.test(message);
}
