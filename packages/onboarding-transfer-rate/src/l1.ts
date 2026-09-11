// L1 — measured, $0, truth external to the author. Each check is defined in the frozen
// protocol (checks.json); this module only implements them. Registry and link truth come
// through a Lookup so the analysis is a pure function of the committed snapshot + caches.

import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { isPrivateHost } from '@portfolio-builds/shared';
import type { Checks } from './protocol';
import { l1Check } from './protocol';
import { fencedBlocks, lines, codeLineMask, proseLines } from './markdown';

export type Category =
  | 'broken-command'
  | 'version-drift'
  | 'broken-link'
  | 'missing-prerequisite'
  | 'auth-wall'
  | 'undefined-success'
  | 'render-blocked'
  | 'no-time-claim';

export interface Finding {
  checkId: string;
  category: Category;
  /** 1-based line in the page text; 0 when the finding is page-level */
  line: number;
  /** verbatim excerpt from that line (<= 200 chars) */
  excerpt: string;
  detail: string;
  /** whether it counts against the L1 pass (auth-wall and informational findings do not) */
  counted: boolean;
}

export interface RegistryInfo {
  exists: boolean;
  latest: string | null;
  deprecated: boolean;
}

export interface LinkResult {
  status: number | null;
  ok: boolean;
  error: string | null;
}

export interface Lookup {
  npm(name: string): Promise<RegistryInfo>;
  pypi(name: string): Promise<RegistryInfo>;
  link(url: string): Promise<LinkResult>;
}

export interface InstallRef {
  ecosystem: 'npm' | 'pypi';
  name: string;
  pin: string | null;
  line: number;
  excerpt: string;
}

const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'text', 'plaintext', 'cmd', 'powershell', 'ps1']);
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

function majorOf(v: string): number | null {
  const m = /^v?(\d+)\./.exec(v) ?? /^v?(\d+)$/.exec(v);
  return m ? Number(m[1]) : null;
}

export interface L1Result {
  findings: Finding[];
  needsCredential: boolean;
  /** zero counted findings */
  passed: boolean;
  installs: InstallRef[];
  linksChecked: number;
}

export interface L1Input {
  text: string;
  links: string[];
  selfUrl: string | null;
  milestoneLine: number | null;
}

export async function runL1(input: L1Input, checks: Checks, lookup: Lookup): Promise<L1Result> {
  const findings: Finding[] = [];
  const { text } = input;

  // L1-pkg-exists + L1-version-drift
  const installs = extractInstalls(text);
  const seenPkg = new Set<string>();
  for (const ref of installs) {
    const key = `${ref.ecosystem}:${ref.ecosystem === 'pypi' ? normalizePypi(ref.name) : ref.name}`;
    if (seenPkg.has(key)) continue;
    seenPkg.add(key);
    const info = ref.ecosystem === 'npm' ? await lookup.npm(ref.name) : await lookup.pypi(normalizePypi(ref.name));
    if (!info.exists) {
      findings.push({
        checkId: 'L1-pkg-exists',
        category: 'broken-command',
        line: ref.line,
        excerpt: ref.excerpt,
        detail: `${ref.ecosystem} package "${ref.name}" not found in its registry`,
        counted: true,
      });
      continue;
    }
    if (ref.pin && info.latest) {
      const a = majorOf(ref.pin);
      const b = majorOf(info.latest);
      if (a !== null && b !== null && b > a) {
        findings.push({
          checkId: 'L1-version-drift',
          category: 'version-drift',
          line: ref.line,
          excerpt: ref.excerpt,
          detail: `pinned ${ref.name}@${ref.pin}; registry latest is ${info.latest} (${b - a} major behind)`,
          counted: true,
        });
      }
    }
    if (info.deprecated) {
      findings.push({
        checkId: 'L1-version-drift',
        category: 'version-drift',
        line: ref.line,
        excerpt: ref.excerpt,
        detail: `${ref.name}: latest release is marked deprecated/yanked in its registry`,
        counted: true,
      });
    }
  }

  // L1-links
  const linkCheck = l1Check(checks, 'L1-links');
  const excludeRe = new RegExp(linkCheck.exclude_re!, 'i');
  const candidates: string[] = [];
  for (const u of input.links) {
    if (candidates.length >= (linkCheck.max_links ?? 25)) break;
    if (input.selfUrl && u.split('#')[0] === input.selfUrl.split('#')[0]) continue;
    if (excludeRe.test(u)) continue;
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    if (isPrivateHost(host)) continue; // "http://localhost:8080" instructions are not links to check
    candidates.push(u);
  }
  for (const u of candidates) {
    const r = await lookup.link(u);
    if (!r.ok) {
      const ln = lines(text).findIndex((l) => l.includes(u));
      findings.push({
        checkId: 'L1-links',
        category: 'broken-link',
        line: ln >= 0 ? ln + 1 : 0,
        excerpt: excerptOf(ln >= 0 ? lines(text)[ln]! : u),
        detail: `GET ${u} -> ${r.status ?? r.error ?? 'no response'}`,
        counted: true,
      });
    }
  }

  // L1-prereq-order
  const prereq = l1Check(checks, 'L1-prereq-order');
  const prose = proseLines(text).map((p) => p.text);
  const proseJoined = prose.join('\n');
  const mask = codeLineMask(text);
  const ls = lines(text);
  const envRes = (prereq.env_var_patterns ?? []).map((p) => new RegExp(p, 'g'));
  const seenEnv = new Set<string>();
  for (let i = 0; i < ls.length; i++) {
    if (!mask[i]) continue;
    for (const re of envRes) {
      re.lastIndex = 0;
      for (const m of ls[i]!.matchAll(re)) {
        const name = m[1]!;
        if (seenEnv.has(name) || /^(?:PATH|HOME|USER|SHELL|PWD|TRUE|FALSE|NULL|NONE)$/.test(name)) continue;
        seenEnv.add(name);
        if (!proseJoined.includes(name)) {
          findings.push({
            checkId: 'L1-prereq-order',
            category: 'missing-prerequisite',
            line: i + 1,
            excerpt: excerptOf(ls[i]!),
            detail: `environment variable ${name} is used in code but never mentioned in prose`,
            counted: true,
          });
        }
      }
    }
  }
  const tools = new Set(prereq.tools ?? []);
  const seenTool = new Set<string>();
  for (const b of fencedBlocks(text)) {
    if (!SHELL_LANGS.has(b.lang)) continue;
    b.code.split('\n').forEach((codeLine, k) => {
      const first = stripPrompt(codeLine).trim().split(/\s+/)[0] ?? '';
      if (!tools.has(first) || seenTool.has(first)) return;
      seenTool.add(first);
      // "mentioned in prose" is matched on the tool's base name: a prose "Python" or "pip"
      // introduces python3 / pip3 (the trailing digit is a version alias, not another tool).
      const base = first.replace(/\d+$/, '');
      const wordRe = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d*\\b`, 'i');
      if (!wordRe.test(proseJoined)) {
        findings.push({
          checkId: 'L1-prereq-order',
          category: 'missing-prerequisite',
          line: b.startLine + 1 + k,
          excerpt: excerptOf(codeLine),
          detail: `command-line tool "${first}" is used but never mentioned in prose`,
          counted: true,
        });
      }
    });
  }

  // L1-code-parse
  const parse = l1Check(checks, 'L1-code-parse');
  const langs = parse.languages ?? {};
  for (const b of fencedBlocks(text)) {
    if (/\.\.\.|…/.test(b.code) || /^\s*>>>/m.test(b.code) || b.code.trim() === '') continue;
    let err: string | null = null;
    if (langs['js']?.includes(b.lang) || langs['ts']?.includes(b.lang)) err = parseJsTs(b.code, b.lang);
    else if (langs['python']?.includes(b.lang)) err = parsePython(b.code);
    else continue;
    if (err) {
      findings.push({
        checkId: 'L1-code-parse',
        category: 'broken-command',
        line: b.startLine,
        excerpt: excerptOf(b.code.split('\n')[0] ?? ''),
        detail: `${b.lang} block does not parse: ${err}`,
        counted: true,
      });
    }
  }

  // L1-auth-wall (stratum)
  const auth = l1Check(checks, 'L1-auth-wall');
  const authRe = new RegExp(auth.pattern!, auth.flags ?? 'i');
  const scopeEnd = input.milestoneLine ?? ls.length;
  let needsCredential = false;
  for (let i = 0; i < scopeEnd; i++) {
    if (authRe.test(ls[i]!)) {
      needsCredential = true;
      findings.push({
        checkId: 'L1-auth-wall',
        category: 'auth-wall',
        line: i + 1,
        excerpt: excerptOf(ls[i]!),
        detail: 'first success requires an API key, account, or token (stratum attribute; not counted)',
        counted: false,
      });
      break;
    }
  }

  const passed = findings.every((f) => !f.counted);
  return { findings, needsCredential, passed, installs, linksChecked: candidates.length };
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
