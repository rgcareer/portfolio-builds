// Copied 2026-09-15 from onboarding-transfer-rate @615cfae src/l1.ts: the install-reference
// extraction helpers (InstallRef, NPM_INSTALL_RE, PIP_INSTALL_RE, stripPrompt, tokensAfter,
// normalizePypi, extractInstalls, scanSegment) and the JS/TS/Python snippet parsers
// (parseJsTs, parsePython) — copied verbatim; test/drift-guard.test.ts hashes each named
// function's source against the OTR original so divergence is visible.
//
// Diverges here: drops the L1-specific check wiring (checks.ts owns that for docmend) and
// adds two parsers OTR never needed — parseJson and parseShell (`bash -n`).

import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { lines, codeLineMask } from './markdown';

export interface InstallRef {
  ecosystem: 'npm' | 'pypi';
  name: string;
  pin: string | null;
  line: number;
  excerpt: string;
}

const NPM_INSTALL_RE = /\b(?:npm (?:i|install|add)|yarn add|pnpm (?:add|install)|bun add)\b(.*)$/;
const PIP_INSTALL_RE = /\b(?:pip3? install|uv pip install|uv add|poetry add|pipx install)\b(.*)$/;

export function excerptOf(s: string): string {
  return s.length > 200 ? s.slice(0, 200) : s;
}

function stripPrompt(l: string): string {
  return l.replace(/^\s*(?:\$|>|%|#)\s+/, '').replace(/^\s*sudo\s+/, '');
}

function tokensAfter(rest: string): string[] {
  const cut = rest.split(/\s*(?:&&|\|\||;|\||#)\s*/)[0] ?? '';
  return cut.trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
}

/** PEP 503 name normalization. */
export function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Install references in every line (code and prose), document order. A prose line is
 * scanned span-by-span inside its backticks so trailing prose words never read as packages.
 */
export function extractInstalls(text: string): InstallRef[] {
  const out: InstallRef[] = [];
  const ls = lines(text);
  const mask = codeLineMask(text);
  for (let i = 0; i < ls.length; i++) {
    const raw = ls[i]!;
    const segments = mask[i] ? [raw] : [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    for (const seg of segments) scanSegment(seg, raw, i + 1, out);
  }
  return out;
}

function scanSegment(segment: string, raw: string, lineNo: number, out: InstallRef[]): void {
  const l = stripPrompt(segment);
  {
    const i = lineNo - 1;
    const npm = NPM_INSTALL_RE.exec(l);
    if (npm) {
      for (const tok of tokensAfter(npm[1]!)) {
        if (/^(?:https?:|git\+|file:|\.|\/|~)/.test(tok) || tok.includes('/') && !tok.startsWith('@')) continue;
        const at = tok.lastIndexOf('@');
        const name = at > 0 ? tok.slice(0, at) : tok;
        const pin = at > 0 ? tok.slice(at + 1) : null;
        if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) continue;
        out.push({ ecosystem: 'npm', name, pin, line: i + 1, excerpt: excerptOf(raw) });
      }
      return;
    }
    const pip = PIP_INSTALL_RE.exec(l);
    if (pip) {
      for (const tok of tokensAfter(pip[1]!)) {
        if (/^(?:https?:|git\+|\.|\/|~|-)/.test(tok) || /\.(?:txt|toml|whl|zip|gz|cfg)$/.test(tok) || tok.includes('/')) continue;
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:(==|>=|<=|~=|>|<)([\w.]+))?/.exec(tok);
        if (!m) continue;
        out.push({ ecosystem: 'pypi', name: m[1]!, pin: m[2] === '==' ? m[3]! : null, line: i + 1, excerpt: excerptOf(raw) });
      }
    }
  }
}

export function parseJsTs(code: string, lang: string): string | null {
  const jsx = lang === 'jsx' || lang === 'tsx';
  const isTs = lang === 'ts' || lang === 'typescript' || lang === 'tsx';
  const r = ts.transpileModule(code, {
    reportDiagnostics: true,
    fileName: `snippet.${isTs ? (jsx ? 'tsx' : 'ts') : jsx ? 'jsx' : 'js'}`,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, allowJs: true },
  });
  const d = (r.diagnostics ?? []).find((x) => x.category === ts.DiagnosticCategory.Error);
  if (!d) return null;
  const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  return `TS${d.code}: ${msg}`;
}

export function parsePython(code: string): string | null {
  const r = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf8', timeout: 10_000 });
  if (r.error) return null; // python3 unavailable: cannot judge; never a finding
  if (r.status === 0) return null;
  const last = (r.stderr ?? '').trim().split('\n').pop() ?? 'SyntaxError';
  return last.slice(0, 200);
}

// ---- New in docmend: JSON and shell parsers -----------------------------------------------

/** `JSON.parse`; returns the error message (truncated) or null when it parses. */
export function parseJson(code: string): string | null {
  try {
    JSON.parse(code);
    return null;
  } catch (err) {
    return (err as Error).message.slice(0, 200);
  }
}

/**
 * `bash -n` (syntax check only, nothing executes) over the fence with shell prompts
 * stripped line-by-line. Returns null when bash is unavailable (cannot judge; never a
 * finding) or the script parses; otherwise the last stderr line, truncated.
 */
export function parseShell(code: string): string | null {
  const stripped = code
    .split('\n')
    .map((l) => stripPrompt(l))
    .join('\n');
  const r = spawnSync('bash', ['-n'], { input: stripped, encoding: 'utf8', timeout: 10_000 });
  if (r.error) return null; // bash unavailable: cannot judge; never a finding
  if (r.status === 0) return null;
  const last = (r.stderr ?? '').trim().split('\n').pop() ?? 'syntax error';
  return last.slice(0, 200);
}
