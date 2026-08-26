import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { byteCompare, normalizePathNfc } from '@skillcheck/core';
import { parseCodepointSpec, type RuleWithPack, type Severity } from './rulesSchema';

// The static analysis engine. STATIC ONLY — it reads bytes and matches patterns; it never
// executes a skill. Every match becomes a finding with machine evidence; evidence text is
// sanitized (invisible codepoints escaped, capped) so the audit never republishes live
// injection payloads. Determinism: files walked in sorted order, matches in index order,
// findings sorted + deduped before return.

export interface RawFinding {
  ruleId: string;
  pack: string;
  severity: Severity;
  file: string; // relative path, NFC-normalized
  line: number; // 1-based
  col: number; // 1-based
  matched: string; // sanitized
  context: string; // sanitized surrounding line(s)
  message: string;
}

export interface SkillFile {
  path: string; // relative to skill root
  content: string;
}

const MATCHED_CAP = 200;
const CONTEXT_CAP = 400;
const MAX_MATCHES_PER_RULE_FILE = 500; // defensive bound against adversarial payload spam
const BINARY_SNIFF_BYTES = 8192;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

// Escape controls, format chars, line/para separators, and non-ASCII spaces — but keep a
// regular space. This is what turns an invisible zero-width/bidi/tag-char payload into
// visible, safe evidence like \u{200B}.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;
// Visually-blank codepoints the unicode pack (UNI-004) flags that fall OUTSIDE the Cc/Cf/Z
// classes (combining grapheme joiner, Hangul/Khmer fillers, Braille blank). Tested by
// codepoint (not a char class \u2014 several are combining marks) so evidence never leaks them raw.
const EXTRA_INVISIBLE = new Set([0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0, 0x2800]);

export function sanitizeEvidence(input: string, cap = MATCHED_CAP): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp !== 0x20 && (INVISIBLE_RE.test(ch) || EXTRA_INVISIBLE.has(cp))) {
      out += `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`;
    } else {
      out += ch;
    }
  }
  if (out.length > cap) out = out.slice(0, cap) + '…';
  return out;
}

// --- offset → line/col -------------------------------------------------------
function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { line: ans + 1, col: offset - starts[ans]! + 1 };
}

function lineText(content: string, starts: number[], lineIdx: number): string {
  const start = starts[lineIdx]!;
  const end = lineIdx + 1 < starts.length ? starts[lineIdx + 1]! - 1 : content.length;
  return content.slice(start, end);
}

function contextFor(content: string, starts: number[], line1: number, ctxLines: number): string {
  const lineIdx = line1 - 1;
  const from = Math.max(0, lineIdx - ctxLines);
  const to = Math.min(starts.length - 1, lineIdx + ctxLines);
  const parts: string[] = [];
  for (let l = from; l <= to; l++) parts.push(sanitizeEvidence(lineText(content, starts, l), MATCHED_CAP));
  const joined = parts.join('\n');
  return joined.length > CONTEXT_CAP ? joined.slice(0, CONTEXT_CAP) + '…' : joined;
}

// --- glob matching (applies_to) ---------------------------------------------
function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const opts = glob
          .slice(i + 1, end)
          .split(',')
          .map((o) => o.split('').map(escapeRe).join(''))
          .join('|');
        out += `(?:${opts})`;
        i = end;
      } else {
        out += '\\{';
      }
    } else {
      out += escapeRe(c);
    }
  }
  return new RegExp(out + '$');
}

// --- compiled rules ----------------------------------------------------------
interface CompiledRule {
  rule: RuleWithPack;
  globRes: RegExp[];
  patternRes: RegExp[];
  codepointRe: RegExp | null;
  scriptRes: RegExp[]; // mixed_script target scripts
  within: 'code_spans' | 'all';
  allowLeadingBom: boolean;
  message: string;
}

function codepointToEscape(cp: number): string {
  return `\\u{${cp.toString(16)}}`;
}

function compileRule(rule: RuleWithPack): CompiledRule {
  const globRes = rule.applies_to.map(globToRegExp);
  const patternRes =
    rule.kind === 'regex' ? (rule.patterns ?? []).map((p) => new RegExp(p, 'g' + (rule.flags ?? ''))) : [];

  let codepointRe: RegExp | null = null;
  if (rule.kind === 'codepoints') {
    const cls = (rule.codepoints ?? [])
      .map((spec) => {
        const { start, end } = parseCodepointSpec(spec);
        return start === end ? codepointToEscape(start) : `${codepointToEscape(start)}-${codepointToEscape(end)}`;
      })
      .join('');
    codepointRe = new RegExp(`[${cls}]`, 'gu');
  }

  let scriptRes: RegExp[] = [];
  let within: 'code_spans' | 'all' = 'code_spans';
  if (rule.kind === 'mixed_script') {
    const opts = (rule.options ?? {}) as { scripts?: string[]; within?: string };
    const scripts = opts.scripts ?? ['Cyrillic', 'Greek'];
    scriptRes = scripts
      .map((s) => {
        try {
          return new RegExp(`\\p{Script=${s}}`, 'u');
        } catch {
          return null;
        }
      })
      .filter((r): r is RegExp => r !== null);
    within = opts.within === 'all' ? 'all' : 'code_spans';
  }

  const allowLeadingBom = Boolean((rule.options as { allow_leading_bom?: boolean } | undefined)?.allow_leading_bom);

  return {
    rule,
    globRes,
    patternRes,
    codepointRe,
    scriptRes,
    within,
    allowLeadingBom,
    message: rule.message ?? rule.title,
  };
}

export function compileRules(rules: RuleWithPack[]): CompiledRule[] {
  return rules.map(compileRule);
}

// --- mixed-script helpers ----------------------------------------------------
const LATIN_RE = /\p{Script=Latin}/u;
const WORD_RE = /[\p{L}\p{M}]+/gu;

interface Region {
  text: string;
  offset: number;
}

function extractCodeSpans(content: string): Region[] {
  const regions: Region[] = [];
  for (const m of content.matchAll(/```[\s\S]*?```/g)) {
    regions.push({ text: m[0], offset: m.index });
  }
  for (const m of content.matchAll(/`[^`\n]+`/g)) {
    regions.push({ text: m[0], offset: m.index });
  }
  return regions;
}

function mixedScriptMatches(
  content: string,
  compiled: CompiledRule,
): { index: number; text: string }[] {
  const regions = compiled.within === 'all' ? [{ text: content, offset: 0 }] : extractCodeSpans(content);
  const out: { index: number; text: string }[] = [];
  for (const region of regions) {
    for (const m of region.text.matchAll(WORD_RE)) {
      const token = m[0];
      if (LATIN_RE.test(token) && compiled.scriptRes.some((re) => re.test(token))) {
        out.push({ index: region.offset + m.index, text: token });
      }
    }
  }
  return out;
}

// --- core scan ---------------------------------------------------------------
function fileApplies(compiled: CompiledRule, file: string): boolean {
  return compiled.globRes.some((re) => re.test(file));
}

function scanContent(file: string, content: string, compiled: CompiledRule[]): RawFinding[] {
  const starts = buildLineStarts(content);
  const findings: RawFinding[] = [];

  const emit = (c: CompiledRule, index: number, matchedRaw: string) => {
    const { line, col } = offsetToLineCol(starts, index);
    findings.push({
      ruleId: c.rule.id,
      pack: c.rule.pack,
      severity: c.rule.severity,
      file,
      line,
      col,
      matched: sanitizeEvidence(matchedRaw, MATCHED_CAP),
      context: contextFor(content, starts, line, c.rule.context_lines),
      message: c.message,
    });
  };

  for (const c of compiled) {
    if (!fileApplies(c, file)) continue;
    let count = 0;
    const cap = () => count++ >= MAX_MATCHES_PER_RULE_FILE;

    if (c.rule.kind === 'regex') {
      for (const re of c.patternRes) {
        for (const m of content.matchAll(re)) {
          if (cap()) break;
          emit(c, m.index, m[0]);
        }
      }
    } else if (c.rule.kind === 'codepoints' && c.codepointRe) {
      for (const m of content.matchAll(c.codepointRe)) {
        // A U+FEFF at file start is a legitimate BOM (common in XML/XSD), not a payload.
        if (c.allowLeadingBom && m.index === 0 && m[0].codePointAt(0) === 0xfeff) continue;
        if (cap()) break;
        emit(c, m.index, m[0]);
      }
    } else if (c.rule.kind === 'mixed_script') {
      for (const m of mixedScriptMatches(content, c)) {
        if (cap()) break;
        emit(c, m.index, m.text);
      }
    }
  }

  return findings;
}

function sortKey(f: RawFinding): string {
  return [f.file, f.ruleId, String(f.line).padStart(9, '0'), String(f.col).padStart(9, '0'), f.matched].join(
    ' ',
  );
}

/** Scan an in-memory set of files. Pure — the fixture/corpus path uses this directly. */
export function scanFiles(files: SkillFile[], rules: RuleWithPack[]): RawFinding[] {
  const compiled = compileRules(rules);
  const findings: RawFinding[] = [];
  const ordered = files
    .map((f) => ({ ...f, path: normalizePathNfc(f.path) }))
    .sort((a, b) => byteCompare(a.path, b.path));
  for (const f of ordered) {
    findings.push(...scanContent(f.path, f.content, compiled));
  }
  // sort + dedupe (a pattern set can double-report the same span)
  findings.sort((a, b) => byteCompare(sortKey(a), sortKey(b)));
  const deduped: RawFinding[] = [];
  let prev = '';
  for (const f of findings) {
    const k = sortKey(f);
    if (k !== prev) {
      deduped.push(f);
      prev = k;
    }
  }
  return deduped;
}

// --- filesystem walk ---------------------------------------------------------
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Recursively collect text files under `dir`, skipping symlinks and known noise dirs. */
export function readSkillFiles(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (abs: string, rel: string): void => {
    const entries = readdirSync(abs).sort(byteCompare);
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(childAbs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never follow symlinks (hostile-repo safety)
      if (st.isDirectory()) {
        walk(childAbs, childRel);
      } else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) continue;
        const buf = readFileSync(childAbs);
        if (isBinary(buf)) continue;
        out.push({ path: childRel, content: buf.toString('utf8') });
      }
    }
  };
  walk(dir, '');
  return out;
}

/** Scan a skill directory from disk. */
export function scanSkillDir(dir: string, rules: RuleWithPack[]): RawFinding[] {
  return scanFiles(readSkillFiles(dir), rules);
}
