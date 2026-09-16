// The D-* drift checks. Each check is defined in the frozen protocol (checks.json); this
// module only implements them. External truth (link status, registry info) comes through a
// Lookup so analysis is a pure function of the committed snapshot + lookup cache.
//
// D-prereq is copied (with this comment as its provenance note) from onboarding-transfer-rate
// @615cfae src/l1.ts's L1-prereq-order rule: an environment variable or CLI tool used inside
// a fenced code block that prose never mentions.

import { isPrivateHost } from '@portfolio-builds/shared';
import type { Checks, LinkRule } from './protocol';
import type { DriftCategory, Evidence, Finding } from './types';
import { fencedBlocks, lines, codeLineMask, proseLines } from './markdown';
import { extractInstalls, parseJsTs, parsePython, parseJson, parseShell, type InstallRef } from './snippets';
import type { Lookup } from './lookup';

export interface PageCheckInput {
  pageId: string;
  text: string;
  links: string[];
  /** Own-repo relative path (e.g. "docs/one.md"); null for site/external pages. */
  path: string | null;
  /** The page's own canonical URL, excluded from its own link check; null when not applicable. */
  selfUrl: string | null;
}

export interface OwnRepoCheckContext {
  tree: string[];
  packageJson: { scripts?: Record<string, string>; engines?: { node?: string } } | null;
}

export interface RunChecksResult {
  findings: Finding[];
  stats: { installs: number; pins: number; snippets: number; linksChecked: number };
}

function push(findings: Finding[], pageId: string, checkId: string, category: DriftCategory, line: number, excerpt: string, detail: string, counted: boolean, evidence: Evidence = {}): void {
  const idx = findings.filter((f) => f.checkId === checkId).length;
  findings.push({ id: `${pageId}:${checkId}:${idx}`, pageId, checkId, category, line, excerpt, detail, counted, evidence });
}

function excerptOf(s: string): string {
  return s.length > 200 ? s.slice(0, 200) : s;
}

// ---- D-link / D-redirect --------------------------------------------------------------------

export function candidateLinks(links: string[], linkRule: LinkRule, isExternal: boolean, selfUrl: string | null): string[] {
  const excludeRe = new RegExp(linkRule.exclude_re, 'i');
  const cap = isExternal ? linkRule.external_max_links : (linkRule.own_max_links ?? Infinity);
  const out: string[] = [];
  for (const u of links) {
    if (out.length >= cap) break;
    if (selfUrl && u.split('#')[0] === selfUrl.split('#')[0]) continue;
    if (excludeRe.test(u)) continue;
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    if (isPrivateHost(host)) continue;
    out.push(u);
  }
  return out;
}

async function runLinkChecks(input: PageCheckInput, findings: Finding[], linkRule: LinkRule, isExternal: boolean, lookup: Lookup): Promise<number> {
  const candidates = candidateLinks(input.links, linkRule, isExternal, input.selfUrl);
  const ls = lines(input.text);
  for (const u of candidates) {
    const chain = await lookup.link(u);
    const ln = ls.findIndex((l) => l.includes(u));
    const line = ln >= 0 ? ln + 1 : 0;
    const excerpt = excerptOf(ln >= 0 ? ls[ln]! : u);
    const ok = chain.error === null && chain.finalStatus !== null && chain.finalStatus >= 200 && chain.finalStatus < 400;
    if (!ok) {
      push(findings, input.pageId, 'D-link', 'broken-link', line, excerpt, `GET ${u} -> ${chain.finalStatus ?? chain.error ?? 'no response'}`, true, { url: u, chain });
      continue;
    }
    const permanent = chain.hops.some((h) => h.status === 301 || h.status === 308);
    const temporary = !permanent && chain.hops.some((h) => h.status === 302 || h.status === 307);
    if (permanent) {
      push(findings, input.pageId, 'D-redirect', 'redirected-link', line, excerpt, `${u} redirects permanently to ${chain.finalUrl}`, true, { url: u, chain });
    } else if (temporary) {
      push(findings, input.pageId, 'D-redirect', 'redirected-link', line, excerpt, `${u} redirects temporarily to ${chain.finalUrl} (informational)`, false, { url: u, chain });
    }
  }
  return candidates.length;
}

// ---- D-pkg-exists / D-pin ---------------------------------------------------------------------

function majorOf(v: string): number | null {
  const m = /^v?(\d+)\./.exec(v) ?? /^v?(\d+)$/.exec(v);
  return m ? Number(m[1]) : null;
}

async function runPackageChecks(input: PageCheckInput, findings: Finding[], lookup: Lookup): Promise<{ installs: InstallRef[]; pins: number }> {
  const installs = extractInstalls(input.text);
  const seen = new Set<string>();
  let pins = 0;
  for (const ref of installs) {
    const key = `${ref.ecosystem}:${ref.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const info = ref.ecosystem === 'npm' ? await lookup.npm(ref.name) : await lookup.pypi(ref.name);
    if (!info.exists) {
      push(findings, input.pageId, 'D-pkg-exists', 'broken-link', ref.line, ref.excerpt, `${ref.ecosystem} package "${ref.name}" not found in its registry`, true, { ecosystem: ref.ecosystem, name: ref.name });
      continue;
    }
    if (ref.pin) {
      pins++;
      const a = majorOf(ref.pin);
      const b = info.latest ? majorOf(info.latest) : null;
      if (a !== null && b !== null && ref.pin !== info.latest) {
        if (b > a) {
          push(findings, input.pageId, 'D-pin', 'version-drift', ref.line, ref.excerpt, `pinned ${ref.name}@${ref.pin}; registry latest is ${info.latest} (${b - a} major behind)`, true, {
            ecosystem: ref.ecosystem,
            name: ref.name,
            pin: ref.pin,
            latest: info.latest,
            deprecated: info.deprecated,
          });
        } else if (b === a) {
          push(findings, input.pageId, 'D-pin', 'stale-pin', ref.line, ref.excerpt, `pinned ${ref.name}@${ref.pin}; registry latest is ${info.latest} (same major, behind)`, true, {
            ecosystem: ref.ecosystem,
            name: ref.name,
            pin: ref.pin,
            latest: info.latest,
            deprecated: info.deprecated,
          });
        }
      }
    }
    if (info.deprecated && info.latest) {
      push(findings, input.pageId, 'D-pin', 'version-drift', ref.line, ref.excerpt, `${ref.name}: registry latest (${info.latest}) is marked deprecated/yanked`, true, {
        ecosystem: ref.ecosystem,
        name: ref.name,
        latest: info.latest,
        deprecated: true,
      });
    }
  }
  return { installs, pins };
}

// ---- D-code-parse -------------------------------------------------------------------------

const IGNORED_FENCE_LANGS = new Set(['console', 'text', 'plaintext', '']);
const JSON_LANGS = new Set(['json']);
const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell']);
const JS_LANGS = new Set(['js', 'javascript', 'mjs', 'cjs', 'jsx']);
const TS_LANGS = new Set(['ts', 'typescript', 'tsx']);
const PY_LANGS = new Set(['python', 'py', 'python3']);

function runCodeParseChecks(input: PageCheckInput, findings: Finding[]): number {
  let checked = 0;
  for (const b of fencedBlocks(input.text)) {
    if (IGNORED_FENCE_LANGS.has(b.lang)) continue;
    if (/\.\.\.|…/.test(b.code) || /^\s*>>>/m.test(b.code) || b.code.trim() === '') continue;
    let err: string | null = null;
    if (JSON_LANGS.has(b.lang)) err = parseJson(b.code);
    else if (SHELL_LANGS.has(b.lang)) err = parseShell(b.code);
    else if (JS_LANGS.has(b.lang) || TS_LANGS.has(b.lang)) err = parseJsTs(b.code, b.lang);
    else if (PY_LANGS.has(b.lang)) err = parsePython(b.code);
    else continue;
    checked++;
    if (err) {
      push(findings, input.pageId, 'D-code-parse', 'unparseable-snippet', b.startLine, excerptOf(b.code.split('\n')[0] ?? ''), `${b.lang || '(no lang)'} block does not parse: ${err}`, true, {
        lang: b.lang,
      });
    }
  }
  return checked;
}

// ---- D-prereq (copied from OTR's L1-prereq-order) ------------------------------------------

/** Exported standalone so reverify.ts's recheck-patched-text can re-run just this check (no network). */
export function runPrereqChecks(input: PageCheckInput, findings: Finding[], checks: Checks): void {
  const def = checks.checks.find((c) => c.id === 'D-prereq')!;
  const envPatterns = (def['env_var_patterns'] as string[] | undefined) ?? [];
  const tools = new Set((def['tools'] as string[] | undefined) ?? []);
  const text = input.text;
  const ls = lines(text);
  const mask = codeLineMask(text);
  const prose = proseLines(text).map((p) => p.text);
  const proseJoined = prose.join('\n');
  const envRes = envPatterns.map((p) => new RegExp(p, 'g'));
  const seenEnv = new Set<string>();
  const blocks = fencedBlocks(text);
  // A prose sentence about a prerequisite must land OUTSIDE the fence it was found in — never
  // between its opening and closing backticks, or it reads as code, not prose. Findings
  // therefore carry insertAfterLine: the fence's own closing line, for llm.ts/patch.ts to
  // anchor an insertion diff on directly (by line number, not substring uniqueness).
  const blockContaining = (lineNo: number): (typeof blocks)[number] | undefined => blocks.find((b) => lineNo >= b.startLine && lineNo <= b.endLine);
  for (let i = 0; i < ls.length; i++) {
    if (!mask[i]) continue;
    for (const re of envRes) {
      re.lastIndex = 0;
      for (const m of ls[i]!.matchAll(re)) {
        const name = m[1]!;
        if (seenEnv.has(name) || /^(?:PATH|HOME|USER|SHELL|PWD|TRUE|FALSE|NULL|NONE)$/.test(name)) continue;
        seenEnv.add(name);
        if (!proseJoined.includes(name)) {
          const insertAfterLine = blockContaining(i + 1)?.endLine ?? i + 1;
          push(findings, input.pageId, 'D-prereq', 'missing-prerequisite', i + 1, excerptOf(ls[i]!), `environment variable ${name} is used in code but never mentioned in prose`, true, { kind: 'env', name, insertAfterLine });
        }
      }
    }
  }
  const seenTool = new Set<string>();
  for (const b of blocks) {
    if (!SHELL_LANGS.has(b.lang) && b.lang !== '') continue;
    b.code.split('\n').forEach((codeLine, k) => {
      const first = codeLine.replace(/^\s*(?:\$|>|%|#)\s+/, '').trim().split(/\s+/)[0] ?? '';
      if (!tools.has(first) || seenTool.has(first)) return;
      seenTool.add(first);
      const base = first.replace(/\d+$/, '');
      const wordRe = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d*\\b`, 'i');
      if (!wordRe.test(proseJoined)) {
        push(findings, input.pageId, 'D-prereq', 'missing-prerequisite', b.startLine + 1 + k, excerptOf(codeLine), `command-line tool "${first}" is used but never mentioned in prose`, true, { kind: 'tool', name: first, insertAfterLine: b.endLine });
      }
    });
  }
}

/** Convenience wrapper around runPrereqChecks that returns a fresh Finding[] instead of mutating one in. */
export function checkPrereqOnly(input: PageCheckInput, checks: Checks): Finding[] {
  const findings: Finding[] = [];
  runPrereqChecks(input, findings, checks);
  return findings;
}

// ---- D-rel-path (own repos only) -----------------------------------------------------------

function posixResolveRelative(pagePath: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // any URL scheme (http:, mailto:, etc.)
  if (target.startsWith('#')) return null;
  const clean = target.split('#')[0]!.split('?')[0]!.trim();
  if (clean === '') return null;
  const segsFrom = (p: string): string[] => p.split('/').filter((s) => s !== '' && s !== '.');
  const pageDirSegs = segsFrom(pagePath).slice(0, -1);
  const targetSegs = clean.startsWith('/') ? [] : pageDirSegs.slice();
  for (const seg of segsFrom(clean)) {
    if (seg === '..') targetSegs.pop();
    else targetSegs.push(seg);
  }
  return targetSegs.join('/');
}

const MD_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function runRelPathChecks(input: PageCheckInput, findings: Finding[], ownRepoCtx: OwnRepoCheckContext): void {
  if (!input.path) return;
  const treeSet = new Set(ownRepoCtx.tree);
  for (const p of proseLines(input.text)) {
    MD_LINK_RE.lastIndex = 0;
    for (const m of p.text.matchAll(MD_LINK_RE)) {
      const resolved = posixResolveRelative(input.path, m[1]!);
      if (resolved === null) continue;
      if (treeSet.has(resolved)) continue;
      const candidates = ownRepoCtx.tree.filter((t) => t.split('/').pop() === resolved.split('/').pop());
      push(findings, input.pageId, 'D-rel-path', 'broken-relative-path', p.line, excerptOf(p.text), `relative path "${m[1]}" resolves to "${resolved}", which does not exist in the repo tree`, true, {
        target: m[1],
        resolved,
        candidates,
      });
    }
  }
}

// ---- D-script (own repos only) -------------------------------------------------------------

function runScriptChecks(input: PageCheckInput, findings: Finding[], checks: Checks, ownRepoCtx: OwnRepoCheckContext): void {
  const def = checks.checks.find((c) => c.id === 'D-script')!;
  const re = new RegExp(def['pattern'] as string, 'g');
  const scripts = ownRepoCtx.packageJson?.scripts ?? {};
  const ls = lines(input.text);
  const seen = new Set<string>();
  for (let i = 0; i < ls.length; i++) {
    re.lastIndex = 0;
    for (const m of ls[i]!.matchAll(re)) {
      const script = m[1]!;
      if (seen.has(script)) continue;
      seen.add(script);
      if (!(script in scripts)) {
        push(findings, input.pageId, 'D-script', 'broken-script', i + 1, excerptOf(ls[i]!), `"npm run ${script}" is documented but package.json has no such script`, true, { script });
      }
    }
  }
}

// ---- D-engine (own repos only) -------------------------------------------------------------

function runEngineChecks(input: PageCheckInput, findings: Finding[], checks: Checks, ownRepoCtx: OwnRepoCheckContext): void {
  const engineNode = ownRepoCtx.packageJson?.engines?.node;
  if (!engineNode) return;
  const requiredMajor = majorOf(engineNode.replace(/^[^\d]*/, ''));
  if (requiredMajor === null) return;
  const def = checks.checks.find((c) => c.id === 'D-engine')!;
  const re = new RegExp(def['pattern'] as string, (def['flags'] as string) ?? 'i');
  for (const p of proseLines(input.text)) {
    const m = re.exec(p.text);
    if (!m) continue;
    const claimedMajor = Number(m[1]);
    if (Number.isFinite(claimedMajor) && claimedMajor !== requiredMajor) {
      push(findings, input.pageId, 'D-engine', 'engine-mismatch', p.line, excerptOf(p.text), `README claims Node ${claimedMajor}; package.json engines.node is "${engineNode}" (major ${requiredMajor})`, true, {
        claimed: claimedMajor,
        required: requiredMajor,
        engineNode,
      });
    }
    break; // only the first claim on the page counts, matching D-prereq/D-link's "first mention" spirit
  }
}

// ---- D-placeholder --------------------------------------------------------------------------

function runPlaceholderChecks(input: PageCheckInput, findings: Finding[], checks: Checks): void {
  const def = checks.checks.find((c) => c.id === 'D-placeholder')!;
  const re = new RegExp(def['pattern'] as string, ((def['flags'] as string) ?? 'i') + 'g');
  for (const p of proseLines(input.text)) {
    re.lastIndex = 0;
    const m = re.exec(p.text);
    if (m) {
      push(findings, input.pageId, 'D-placeholder', 'placeholder-text', p.line, excerptOf(p.text), `unresolved placeholder marker "${m[0]}"`, true, { match: m[0] });
    }
  }
}

// ---- Orchestrator -------------------------------------------------------------------------

export async function runChecks(input: PageCheckInput, checks: Checks, linkRule: LinkRule, isExternal: boolean, lookup: Lookup, ownRepoCtx: OwnRepoCheckContext | null): Promise<RunChecksResult> {
  const findings: Finding[] = [];
  const linksChecked = await runLinkChecks(input, findings, linkRule, isExternal, lookup);
  const { installs, pins } = await runPackageChecks(input, findings, lookup);
  const snippets = runCodeParseChecks(input, findings);
  runPrereqChecks(input, findings, checks);
  if (ownRepoCtx) {
    runRelPathChecks(input, findings, ownRepoCtx);
    runScriptChecks(input, findings, checks, ownRepoCtx);
    runEngineChecks(input, findings, checks, ownRepoCtx);
  }
  runPlaceholderChecks(input, findings, checks);
  return { findings, stats: { installs: installs.length, pins, snippets, linksChecked } };
}
