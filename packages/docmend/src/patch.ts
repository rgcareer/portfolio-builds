// Unified diff generation and application. A proposal's `diff` always targets exactly one
// line, located by requiring the substring being replaced to occur exactly once in the
// whole raw file — if it is not unique, no diff is produced (ambiguous edits are never
// silently guessed at). applyUnifiedDiff is the reverse: it is what reverify.ts's
// patch-applies method checks against the proposal's recorded expected output, and what
// `docmend repro` uses to re-derive out/patches/ offline.

export interface DiffOk {
  ok: true;
  diff: string;
  /** 1-based line number the edit lands on. */
  line: number;
  oldLine: string;
  newLine: string;
}

export interface DiffFail {
  ok: false;
  reason: 'not-found' | 'ambiguous';
}

export type DiffResult = DiffOk | DiffFail;

const HUNK_HEADER_RE = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;

/** Finds the 0-based line index containing byte offset `idx1` of `raw`, split on '\n'. */
function lineIndexAt(rawLines: string[], idx1: number): number {
  let pos = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const lineLen = rawLines[i]!.length;
    if (idx1 >= pos && idx1 <= pos + lineLen) return i;
    pos += lineLen + 1;
  }
  return -1;
}

/** Locates the unique line containing `substring`, or a failure reason. */
function locateUniqueLine(raw: string, substring: string): { lineIdx: number; rawLines: string[] } | DiffFail {
  if (substring === '') return { ok: false, reason: 'not-found' };
  const idx1 = raw.indexOf(substring);
  if (idx1 < 0) return { ok: false, reason: 'not-found' };
  const idx2 = raw.indexOf(substring, idx1 + 1);
  if (idx2 >= 0) return { ok: false, reason: 'ambiguous' };
  const rawLines = raw.split('\n');
  const lineIdx = lineIndexAt(rawLines, idx1);
  if (lineIdx < 0) return { ok: false, reason: 'not-found' };
  return { lineIdx, rawLines };
}

/**
 * A single-hunk unified diff that replaces the first (and only) occurrence of
 * `oldSubstring` in `raw` with `replacement`, keeping `contextLines` of surrounding
 * context. Refuses (no diff) when `oldSubstring` occurs zero or more than once in `raw`.
 */
export function makeUnifiedDiff(raw: string, oldSubstring: string, replacement: string, contextLines = 3, fileLabel = 'a/file'): DiffResult {
  const located = locateUniqueLine(raw, oldSubstring);
  if ('ok' in located) return located;
  const { lineIdx, rawLines } = located;

  const oldLine = rawLines[lineIdx]!;
  const newLine = oldLine.split(oldSubstring).join(replacement);
  const start = Math.max(0, lineIdx - contextLines);
  const end = Math.min(rawLines.length - 1, lineIdx + contextLines);
  const totalLines = end - start + 1;

  const hunkLines: string[] = [];
  for (let i = start; i <= end; i++) {
    if (i === lineIdx) {
      hunkLines.push(`-${oldLine}`);
      hunkLines.push(`+${newLine}`);
    } else {
      hunkLines.push(` ${rawLines[i]}`);
    }
  }
  const header = `@@ -${start + 1},${totalLines} +${start + 1},${totalLines} @@`;
  const diff = [`--- ${fileLabel}`, `+++ ${fileLabel}`, header, ...hunkLines].join('\n') + '\n';
  return { ok: true, diff, line: lineIdx + 1, oldLine, newLine };
}

/**
 * A single-hunk unified diff that INSERTS `newLine` immediately after the unique line
 * containing `anchorSubstring` (the anchor itself is unchanged, shown as context). Used by
 * llm.ts for prose-prerequisite proposals, which add a sentence rather than rewrite one.
 * Same uniqueness refusal as makeUnifiedDiff.
 */
export function makeInsertionDiff(raw: string, anchorSubstring: string, newLine: string, contextLines = 3, fileLabel = 'a/file'): DiffResult {
  const located = locateUniqueLine(raw, anchorSubstring);
  if ('ok' in located) return located;
  const { lineIdx, rawLines } = located;

  const anchorLine = rawLines[lineIdx]!;
  const start = Math.max(0, lineIdx - contextLines);
  const end = Math.min(rawLines.length - 1, lineIdx + contextLines);
  const oldCount = end - start + 1;
  const newCount = oldCount + 1;

  const hunkLines: string[] = [];
  for (let i = start; i <= end; i++) {
    hunkLines.push(` ${rawLines[i]}`);
    if (i === lineIdx) hunkLines.push(`+${newLine}`);
  }
  const header = `@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`;
  const diff = [`--- ${fileLabel}`, `+++ ${fileLabel}`, header, ...hunkLines].join('\n') + '\n';
  return { ok: true, diff, line: lineIdx + 1, oldLine: anchorLine, newLine };
}

/**
 * A single-hunk unified diff that inserts `newLine` immediately after 1-based line
 * `afterLine`, located by position rather than substring uniqueness — used when the caller
 * already knows exactly which line to anchor on (e.g. a fenced code block's closing line)
 * and inserting inside the fence, as a substring-anchored insertion right after the
 * offending code line would, is wrong (the sentence would land inside the fence as code,
 * not prose).
 */
export function makeInsertionDiffAtLine(raw: string, afterLine: number, newLine: string, contextLines = 3, fileLabel = 'a/file'): DiffResult {
  const rawLines = raw.split('\n');
  const lineIdx = afterLine - 1;
  if (lineIdx < 0 || lineIdx >= rawLines.length) return { ok: false, reason: 'not-found' };
  const anchorLine = rawLines[lineIdx]!;
  const start = Math.max(0, lineIdx - contextLines);
  const end = Math.min(rawLines.length - 1, lineIdx + contextLines);
  const oldCount = end - start + 1;
  const newCount = oldCount + 1;
  const hunkLines: string[] = [];
  for (let i = start; i <= end; i++) {
    hunkLines.push(` ${rawLines[i]}`);
    if (i === lineIdx) hunkLines.push(`+${newLine}`);
  }
  const header = `@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`;
  const diff = [`--- ${fileLabel}`, `+++ ${fileLabel}`, header, ...hunkLines].join('\n') + '\n';
  return { ok: true, diff, line: lineIdx + 1, oldLine: anchorLine, newLine };
}

/**
 * True when every context (' ') and removed ('-') line in the hunk still matches `original`
 * at the position the hunk header claims. False means the underlying content moved since
 * the diff was generated (reverify.ts's patch-applies staleness guard) — unlike
 * applyUnifiedDiff, which trusts the header's position and never checks this.
 */
export function diffAppliesCleanly(original: string, diff: string): boolean {
  const diffLines = diff.split('\n');
  const hunkIdx = diffLines.findIndex((l) => l.startsWith('@@'));
  if (hunkIdx < 0) return false;
  const header = HUNK_HEADER_RE.exec(diffLines[hunkIdx]!);
  if (!header) return false;
  const oldStart = Number(header[1]) - 1;
  const origLines = original.split('\n');
  let cursor = oldStart;
  for (let i = hunkIdx + 1; i < diffLines.length; i++) {
    const l = diffLines[i]!;
    const tag = l[0];
    if (tag !== ' ' && tag !== '-' && tag !== '+') break;
    const content = l.slice(1);
    if (tag === ' ' || tag === '-') {
      if (origLines[cursor] !== content) return false;
      cursor++;
    }
  }
  return true;
}

/** Applies a single-hunk unified diff (as produced by makeUnifiedDiff) to `original`. Returns null on a malformed diff. */
export function applyUnifiedDiff(original: string, diff: string): string | null {
  const diffLines = diff.split('\n');
  const hunkIdx = diffLines.findIndex((l) => l.startsWith('@@'));
  if (hunkIdx < 0) return null;
  const header = HUNK_HEADER_RE.exec(diffLines[hunkIdx]!);
  if (!header) return null;
  const oldStart = Number(header[1]) - 1;

  const origLines = original.split('\n');
  const before = origLines.slice(0, oldStart);
  let cursor = oldStart;
  const middle: string[] = [];
  for (let i = hunkIdx + 1; i < diffLines.length; i++) {
    const l = diffLines[i]!;
    const tag = l[0];
    if (tag !== ' ' && tag !== '-' && tag !== '+') break; // end of hunk body (trailing '' from the final \n, or EOF)
    const content = l.slice(1);
    if (tag === ' ') {
      middle.push(content);
      cursor++;
    } else if (tag === '-') {
      cursor++;
    } else {
      middle.push(content);
    }
  }
  const after = origLines.slice(cursor);
  return [...before, ...middle, ...after].join('\n');
}
