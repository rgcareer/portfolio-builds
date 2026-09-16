// Copied 2026-09-15 from onboarding-transfer-rate @615cfae; diverges here.
// (No divergence in this file — a byte-identical copy; test/drift-guard.test.ts hashes
// the body below against the OTR original so any future edit is caught.)

export interface FencedBlock {
  lang: string;
  code: string;
  /** 1-based line of the opening fence */
  startLine: number;
  /** 1-based line of the closing fence (or last line if unterminated) */
  endLine: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

const FENCE_RE = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*.*$/;

export function lines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** Fenced code blocks in document order. */
export function fencedBlocks(text: string): FencedBlock[] {
  const ls = lines(text);
  const out: FencedBlock[] = [];
  let open: { fence: string; lang: string; start: number; buf: string[] } | null = null;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const m = FENCE_RE.exec(l);
    if (!open) {
      if (m) open = { fence: m[1]!, lang: (m[2] ?? '').toLowerCase(), start: i + 1, buf: [] };
      continue;
    }
    if (m && m[1]!.startsWith(open.fence[0]!) && m[1]!.length >= open.fence.length && (m[2] ?? '') === '') {
      out.push({ lang: open.lang, code: open.buf.join('\n'), startLine: open.start, endLine: i + 1 });
      open = null;
    } else {
      open.buf.push(l);
    }
  }
  if (open) out.push({ lang: open.lang, code: open.buf.join('\n'), startLine: open.start, endLine: ls.length });
  return out;
}

/** Boolean per line (index 0 = line 1): true when the line is inside or is a fence. */
export function codeLineMask(text: string): boolean[] {
  const ls = lines(text);
  const mask = new Array<boolean>(ls.length).fill(false);
  for (const b of fencedBlocks(text)) for (let i = b.startLine - 1; i <= b.endLine - 1; i++) mask[i] = true;
  return mask;
}

/** ATX headings outside code fences. */
export function headings(text: string): Heading[] {
  const ls = lines(text);
  const mask = codeLineMask(text);
  const out: Heading[] = [];
  for (let i = 0; i < ls.length; i++) {
    if (mask[i]) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ls[i]!);
    if (m) out.push({ level: m[1]!.length, text: m[2]!, line: i + 1 });
  }
  return out;
}

/**
 * The section that starts at the first heading matching `re`: from that heading line to
 * the line before the next heading of the same or higher level. Null when no heading
 * matches.
 */
export function sectionByHeading(text: string, re: RegExp): { text: string; startLine: number; endLine: number; heading: Heading } | null {
  const hs = headings(text);
  const idx = hs.findIndex((h) => re.test(h.text));
  if (idx < 0) return null;
  const h = hs[idx]!;
  const next = hs.slice(idx + 1).find((x) => x.level <= h.level);
  const ls = lines(text);
  const endLine = next ? next.line - 1 : ls.length;
  return { text: ls.slice(h.line - 1, endLine).join('\n') + '\n', startLine: h.line, endLine, heading: h };
}

/** Prose lines (outside fences) with their 1-based numbers. */
export function proseLines(text: string): { line: number; text: string }[] {
  const ls = lines(text);
  const mask = codeLineMask(text);
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < ls.length; i++) if (!mask[i]) out.push({ line: i + 1, text: ls[i]! });
  return out;
}

/** Strip inline code spans so a prose-only regex does not match inside backticks. */
export function withoutInlineCode(s: string): string {
  return s.replace(/`[^`]*`/g, ' ');
}
