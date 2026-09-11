// Probe each candidate for its official quickstart in the frozen probe order, then
// snapshot the page: raw bytes, deterministic text, and a manifest with hashes. Every
// fetch goes through the SSRF-guarded fetch with the protocol's timeout and byte cap.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeFetchText, sha256Hex, stableStringify, isPrivateHost, redactDeep, type SafeFetchTextResult } from '@portfolio-builds/shared';
import type { Protocol } from './protocol';
import type { Candidate, Exclusion } from './seed';
import { textifyHtml, textifyMarkdown, resolveLink, decodeEntities, type Textified } from './textify';
import { sectionByHeading, fencedBlocks } from './markdown';

export interface Manifest {
  id: string;
  repo: string;
  stars: number;
  probe: string;
  url: string;
  finalUrl: string;
  hops: number;
  status: number;
  fetchedAt: string;
  kind: 'html' | 'markdown';
  rawFile: string;
  bytes: number;
  sha256Raw: string;
  sha256Text: string;
  title: string | null;
  /** P3 only: the heading and line span of the extracted section within the README */
  section?: { heading: string; startLine: number; endLine: number };
  /** set when the HTML page was render-blocked and its raw-markdown fallback was used */
  fallbackFrom?: string;
  links: string[];
}

export type ProbeOutcome = { status: 'snapshotted'; manifest: Manifest } | { status: 'excluded'; exclusion: Exclusion };

interface FetchCfg {
  protocol: Protocol;
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
}

function fetchPage(url: string, cfg: FetchCfg): Promise<SafeFetchTextResult> {
  const f = cfg.protocol.corpusRule.fetch;
  return safeFetchText(url, {
    timeoutMs: f.timeout_ms,
    maxBytes: f.max_bytes,
    headers: { 'user-agent': f.user_agent, accept: 'text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.8' },
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  });
}

function isRenderBlocked(text: string): boolean {
  return text.length < 500 || fencedBlocks(text).length === 0;
}

/** github.com/<o>/<r>/(edit|blob)/<ref>/<path> -> raw.githubusercontent.com/<o>/<r>/<ref>/<path> */
export function toRawGithub(url: string): string | null {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:edit|blob)\/([^/]+)\/(.+)$/.exec(url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : null;
}

/** Visible-text anchors of an HTML page: [{ text, href }] in document order. */
export function anchors(html: string, baseUrl: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = resolveLink(m[1] ?? m[2] ?? '', baseUrl);
    if (!href) continue;
    const text = decodeEntities(m[3]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    out.push({ text, href });
  }
  return out;
}

interface Page {
  probe: string;
  url: string;
  res: Extract<SafeFetchTextResult, { ok: true }>;
  textified: Textified;
  section?: Manifest['section'];
  fallbackFrom?: string;
}

async function tryFallback(page: Page, cfg: FetchCfg): Promise<Page | null> {
  const edit = page.textified.editLink;
  if (!edit) return null;
  const raw = toRawGithub(edit);
  if (!raw) return null;
  const r = await fetchPage(raw, cfg);
  if (!r.ok || r.status !== 200) return null;
  const t = textifyMarkdown(r.text, raw);
  if (isRenderBlocked(t.text)) return null;
  return { probe: page.probe, url: raw, res: r, textified: t, fallbackFrom: page.url };
}

export async function probeCandidate(c: Candidate, cfg: FetchCfg): Promise<{ page: Page | null; sawRenderBlocked: boolean; fetchFailures: number; attempts: string[] }> {
  const { corpusRule } = cfg.protocol;
  const qsRe = new RegExp(corpusRule.quickstart.text_re, corpusRule.quickstart.text_re_flags);
  const attempts: string[] = [];
  let sawRenderBlocked = false;
  let fetchFailures = 0;

  const admit = async (probe: string, url: string, transform: (r: Extract<SafeFetchTextResult, { ok: true }>) => Page | null): Promise<Page | null> => {
    attempts.push(`${probe} ${url}`);
    const r = await fetchPage(url, cfg);
    if (!r.ok || r.status !== 200) {
      fetchFailures++;
      attempts.push(`  -> ${r.ok ? `HTTP ${r.status}` : r.error}`);
      return null;
    }
    const page = transform(r);
    if (!page) {
      attempts.push('  -> no quickstart on page');
      return null;
    }
    if (isRenderBlocked(page.textified.text)) {
      const fb = await tryFallback(page, cfg);
      if (fb) {
        attempts.push(`  -> render-blocked; raw-markdown fallback ${fb.url}`);
        return fb;
      }
      sawRenderBlocked = true;
      attempts.push('  -> render-blocked, no fallback');
      return null;
    }
    return page;
  };

  // P1: homepage link whose visible text is a quickstart phrase
  let homepage: URL | null = null;
  if (c.homepage) {
    try {
      const u = new URL(c.homepage);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== 'github.com' && !isPrivateHost(u.hostname)) homepage = u;
    } catch {
      homepage = null;
    }
  }
  if (homepage) {
    attempts.push(`P1-homepage ${homepage.href}`);
    const hp = await fetchPage(homepage.href, cfg);
    if (!hp.ok || hp.status !== 200) {
      fetchFailures++;
      attempts.push(`  -> ${hp.ok ? `HTTP ${hp.status}` : hp.error}`);
    } else {
      const hpUrl = hp.finalUrl;
      const link = anchors(hp.text, hpUrl).find((a) => qsRe.test(a.text));
      if (link) {
        let ok = false;
        try {
          const target = new URL(link.href);
          const hpHost = new URL(hpUrl).hostname;
          ok = target.hostname === hpHost || (target.hostname === 'github.com' && target.pathname.toLowerCase().startsWith(`/${c.full_name.toLowerCase()}`));
        } catch {
          ok = false;
        }
        if (ok) {
          const page = await admit('P1-homepage-link', link.href, (r) => ({ probe: 'P1-homepage-link', url: link.href, res: r, textified: textifyHtml(r.text, r.finalUrl) }));
          if (page) return { page, sawRenderBlocked, fetchFailures, attempts };
        } else attempts.push(`  -> link host not allowed: ${link.href}`);
      } else attempts.push('  -> no quickstart link on homepage');
    }
    // P2: well-known paths on the homepage origin
    const paths = corpusRule.quickstart.probe_order.find((p) => p.id === 'P2-well-known-path')?.paths ?? [];
    for (const p of paths) {
      const url = new URL(p, homepage.origin + '/').href;
      const page = await admit('P2-well-known-path', url, (r) => ({ probe: 'P2-well-known-path', url, res: r, textified: textifyHtml(r.text, r.finalUrl) }));
      if (page) return { page, sawRenderBlocked, fetchFailures, attempts };
    }
  } else attempts.push('P1/P2 skipped: no eligible homepage');

  // P3: README section
  const readmeUrl = `https://raw.githubusercontent.com/${c.full_name}/HEAD/README.md`;
  const page = await admit('P3-readme-section', readmeUrl, (r) => {
    const full = textifyMarkdown(r.text, readmeUrl);
    const sec = sectionByHeading(full.text, qsRe);
    if (!sec) return null;
    const t = textifyMarkdown(sec.text, readmeUrl);
    return {
      probe: 'P3-readme-section',
      url: readmeUrl,
      res: r,
      textified: { ...t, title: full.title },
      section: { heading: sec.heading.text, startLine: sec.startLine, endLine: sec.endLine },
    };
  });
  return { page, sawRenderBlocked, fetchFailures, attempts };
}

export async function snapshotCandidate(c: Candidate, corpusDir: string, cfg: FetchCfg): Promise<ProbeOutcome & { attempts: string[] }> {
  const now = new Date().toISOString();
  const { page, sawRenderBlocked, fetchFailures, attempts } = await probeCandidate(c, cfg);
  if (!page) {
    const reason = sawRenderBlocked ? 'render-blocked' : fetchFailures > 0 && attempts.filter((a) => a.startsWith('  -> no quickstart')).length === 0 ? 'fetch-failed' : 'no-quickstart-found';
    return { status: 'excluded', exclusion: redactDeep({ full_name: c.full_name, reason, detail: attempts.join(' | '), stage: 'snapshot', at: now }), attempts };
  }
  const dir = resolve(corpusDir, c.id);
  mkdirSync(dir, { recursive: true });
  const rawFile = page.textified.kind === 'html' ? 'raw.html' : 'raw.md';
  writeFileSync(resolve(dir, rawFile), page.res.text);
  writeFileSync(resolve(dir, 'text.txt'), page.textified.text);
  const manifest: Manifest = {
    id: c.id,
    repo: c.full_name,
    stars: c.stars,
    probe: page.probe,
    url: page.url,
    finalUrl: page.res.finalUrl,
    hops: page.res.hops,
    status: page.res.status,
    fetchedAt: now,
    kind: page.textified.kind,
    rawFile,
    bytes: page.res.bytes,
    sha256Raw: sha256Hex(page.res.text),
    sha256Text: sha256Hex(page.textified.text),
    title: page.textified.title,
    ...(page.section ? { section: page.section } : {}),
    ...(page.fallbackFrom ? { fallbackFrom: page.fallbackFrom } : {}),
    links: page.textified.links,
  };
  // Raw and text pages stay verbatim (public vendor content); the manifest we generate does not
  // carry personal-profile URLs or emails (link list, attempts).
  const redacted = redactDeep(manifest);
  writeFileSync(resolve(dir, 'manifest.json'), stableStringify(redacted));
  return { status: 'snapshotted', manifest: redacted, attempts };
}

export function corpusHas(corpusDir: string, id: string): boolean {
  return existsSync(resolve(corpusDir, id, 'manifest.json'));
}
