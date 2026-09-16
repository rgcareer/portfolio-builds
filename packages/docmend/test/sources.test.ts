import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  walkFiles,
  filterMarkdownPages,
  discoverOwnRepoPages,
  computePageId,
  extractSameOriginLinks,
  extractSitemapLocs,
  discoverSitePages,
  sitePageRefs,
  discoverExternalPages,
} from '../src/sources';
import type { OwnRepoRule, SiteRule } from '../src/protocol';

const FIXTURES = resolve(__dirname, 'fixtures');
const TREE_EXCLUDE_RE = /(^|\/)(node_modules|dist|\.git|\.claude)(\/|$)|(^|\/)\.env[^/]*$|\.pem$/;

describe('source-discovery exclusions (own repos)', () => {
  const root = resolve(FIXTURES, 'own-repo-a');

  it('walkFiles excludes node_modules, dist, .git, .claude, and dotenv files', () => {
    const tree = walkFiles(root, TREE_EXCLUDE_RE);
    expect(tree).not.toContain('node_modules/ignored.md');
    expect(tree).not.toContain('dist/ignored.md');
    expect(tree).not.toContain('.git/ignored');
    expect(tree).not.toContain('.claude/ignored.md');
    expect(tree).not.toContain('.env.local');
  });

  it('walkFiles keeps README.md, docs files (nested), and other non-excluded files', () => {
    const tree = walkFiles(root, TREE_EXCLUDE_RE);
    expect(tree).toContain('README.md');
    expect(tree).toContain('docs/one.md');
    expect(tree).toContain('docs/nested/two.md');
    expect(tree).toContain('notes.txt');
  });

  it('filterMarkdownPages keeps only README.md and docs/**/*.md', () => {
    const tree = walkFiles(root, TREE_EXCLUDE_RE);
    const md = filterMarkdownPages(tree);
    expect(md.sort()).toEqual(['README.md', 'docs/nested/two.md', 'docs/one.md']);
  });

  it('discoverOwnRepoPages reads each markdown file, assigns a stable pageId, and records git provenance', () => {
    const rule: OwnRepoRule = { id: 'repo-a', local: root, url: 'https://github.com/rgcareer/repo-a', files: 'README.md + docs/**/*.md' };
    const fakeGit = () => ({ commit: 'deadbeef', remoteUrl: 'https://github.com/rgcareer/repo-a.git', porcelainCount: 0 });
    const d = discoverOwnRepoPages(rule, TREE_EXCLUDE_RE, { gitProvenance: fakeGit });
    expect(d.repo).toBe('repo-a');
    expect(d.pageRefs).toHaveLength(3);
    expect(d.files['README.md']!.trim()).toBe('# Repo A');
    expect(d.provenance).toEqual({ commit: 'deadbeef', remoteUrl: 'https://github.com/rgcareer/repo-a.git', porcelainCount: 0 });
    // pageId is deterministic: same source+path always yields the same id.
    const again = discoverOwnRepoPages(rule, TREE_EXCLUDE_RE, { gitProvenance: fakeGit });
    expect(d.pageRefs.map((p) => p.pageId)).toEqual(again.pageRefs.map((p) => p.pageId));
  });

  it('computePageId is deterministic and source-sensitive (same path, different source -> different id)', () => {
    const a = computePageId('own-repo:repo-a', 'README.md');
    const b = computePageId('own-repo:repo-b', 'README.md');
    expect(a).toHaveLength(10);
    expect(a).not.toBe(b);
    expect(computePageId('own-repo:repo-a', 'README.md')).toBe(a);
  });
});

describe('site crawl (getsmartai.ai): root + same-origin depth-1 + sitemap', () => {
  const rule: SiteRule = { id: 'getsmartai', origin: 'https://getsmartai.ai', depth: 1, use_sitemap: true, sitemap_path: '/sitemap.xml' };

  it('extractSameOriginLinks keeps only same-origin http(s) anchors, resolved and deduplicated', () => {
    const html = `
      <a href="/pricing">Pricing</a>
      <a href="https://getsmartai.ai/about">About</a>
      <a href="https://other.example/x">External</a>
      <a href="mailto:hi@getsmartai.ai">Mail</a>
      <a href="/pricing#section">Pricing again</a>
    `;
    const links = extractSameOriginLinks(html, rule.origin);
    expect(links).toEqual(['https://getsmartai.ai/pricing', 'https://getsmartai.ai/about']);
  });

  it('extractSitemapLocs reads <loc> entries', () => {
    const xml = '<urlset><url><loc>https://getsmartai.ai/a</loc></url><url><loc>https://getsmartai.ai/b</loc></url></urlset>';
    expect(extractSitemapLocs(xml)).toEqual(['https://getsmartai.ai/a', 'https://getsmartai.ai/b']);
  });

  it('discoverSitePages combines root, its depth-1 links, and the sitemap, deduplicated', async () => {
    const fetchText = async (url: string) => {
      if (url === 'https://getsmartai.ai/') {
        return { ok: true, status: 200, text: '<a href="/pricing">Pricing</a><a href="/about">About</a>' };
      }
      if (url === 'https://getsmartai.ai/sitemap.xml') {
        return { ok: true, status: 200, text: '<urlset><url><loc>https://getsmartai.ai/about</loc></url><url><loc>https://getsmartai.ai/blog</loc></url></urlset>' };
      }
      return { ok: false, status: 404, text: '' };
    };
    const pages = await discoverSitePages(rule, fetchText);
    const urls = pages.map((p) => p.url);
    expect(urls).toContain('https://getsmartai.ai/');
    expect(urls).toContain('https://getsmartai.ai/pricing');
    expect(urls).toContain('https://getsmartai.ai/about');
    expect(urls).toContain('https://getsmartai.ai/blog');
    // /about appears once even though both the depth-1 crawl and the sitemap named it.
    expect(urls.filter((u) => u === 'https://getsmartai.ai/about')).toHaveLength(1);
  });

  it('discoverSitePages skips the sitemap when use_sitemap is false', async () => {
    const noSitemapRule: SiteRule = { ...rule, use_sitemap: false };
    let sitemapFetched = false;
    const fetchText = async (url: string) => {
      if (url.endsWith('sitemap.xml')) sitemapFetched = true;
      if (url === 'https://getsmartai.ai/') return { ok: true, status: 200, text: '' };
      return { ok: false, status: 404, text: '' };
    };
    await discoverSitePages(noSitemapRule, fetchText);
    expect(sitemapFetched).toBe(false);
  });

  it('sitePageRefs assigns a pageId per URL scoped to the site source id', () => {
    const refs = sitePageRefs(rule, [{ url: 'https://getsmartai.ai/pricing', via: 'depth1' }]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.source).toBe('site');
    expect(refs[0]!.pageId).toBe(computePageId('site:getsmartai', 'https://getsmartai.ai/pricing'));
  });
});

describe('external adapter over onboarding-transfer-rate corpus (read-only)', () => {
  const rule = { id: 'otr-quickstarts', pointer: 'external-otr-like/data/corpus', id_prefix: 'q_' };

  it('lists only q_*-prefixed entries that carry a manifest.json', () => {
    const refs = discoverExternalPages(rule, FIXTURES);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.path).sort()).toEqual(['q_aaa0000001', 'q_bbb0000002']);
    expect(refs.every((r) => r.source === 'external')).toBe(true);
  });

  it('returns an empty list when the pointed-at directory does not exist', () => {
    const refs = discoverExternalPages({ id: 'x', pointer: 'nope-does-not-exist', id_prefix: 'q_' }, FIXTURES);
    expect(refs).toEqual([]);
  });
});
