import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256Hex, assertNoPii } from '@portfolio-builds/shared';
import { snapshotOwnRepoPage, snapshotSitePage, snapshotExternalPage, corpusHas, readManifest, readManifestText, readManifests } from '../src/snapshot';
import { textifyMarkdown, textifyHtml } from '../src/textify';
import type { PageRef } from '../src/types';

const corpusDir = resolve(__dirname, 'fixtures', 'corpus-tmp');

beforeEach(() => {
  if (existsSync(corpusDir)) rmSync(corpusDir, { recursive: true, force: true });
  mkdirSync(corpusDir, { recursive: true });
});
afterEach(() => {
  if (existsSync(corpusDir)) rmSync(corpusDir, { recursive: true, force: true });
});

const ownRef: PageRef = { pageId: 'abc1234567', source: 'own-repo', sourceId: 'repo-a', repo: 'repo-a', path: 'README.md', url: null };

describe('snapshotOwnRepoPage', () => {
  it('writes raw.md, text.txt, and manifest.json with matching hashes', () => {
    const raw = '# Hello\n\nSee [docs](https://example.com/docs).\n';
    const t = textifyMarkdown(raw, null);
    const manifest = snapshotOwnRepoPage(ownRef, raw, t, corpusDir);

    expect(manifest.pageId).toBe('abc1234567');
    expect(manifest.kind).toBe('markdown');
    expect(manifest.rawFile).toBe('raw.md');
    expect(manifest.sha256Raw).toBe(sha256Hex(raw));
    expect(manifest.sha256Text).toBe(sha256Hex(t.text));
    expect(manifest.title).toBe('Hello');

    const dir = resolve(corpusDir, 'abc1234567');
    expect(readFileSync(resolve(dir, 'raw.md'), 'utf8')).toBe(raw);
    expect(readFileSync(resolve(dir, 'text.txt'), 'utf8')).toBe(t.text);
    expect(corpusHas(corpusDir, 'abc1234567')).toBe(true);
  });

  it('round-trips through readManifest / readManifestText', () => {
    const raw = '# Title\n';
    snapshotOwnRepoPage(ownRef, raw, textifyMarkdown(raw, null), corpusDir);
    const m = readManifest(corpusDir, ownRef.pageId);
    expect(m.path).toBe('README.md');
    expect(readManifestText(corpusDir, ownRef.pageId)).toContain('Title');
  });
});

describe('snapshotSitePage', () => {
  it('writes raw.html and textifies via textifyHtml', () => {
    const siteRef: PageRef = { pageId: 'site000001', source: 'site', sourceId: 'getsmartai', repo: null, path: 'https://getsmartai.ai/', url: 'https://getsmartai.ai/' };
    const html = '<html><head><title>Get Smart AI</title></head><body><h1>Welcome</h1><a href="https://getsmartai.ai/pricing">Pricing</a></body></html>';
    const t = textifyHtml(html, siteRef.url!);
    const manifest = snapshotSitePage(siteRef, html, t, corpusDir);
    expect(manifest.kind).toBe('html');
    expect(manifest.rawFile).toBe('raw.html');
    expect(manifest.title).toBe('Get Smart AI');
    expect(manifest.links).toContain('https://getsmartai.ai/pricing');
  });
});

describe('snapshotExternalPage', () => {
  it('copies an OTR quickstart through verbatim without re-deriving text', () => {
    const extRef: PageRef = { pageId: 'ext0000001', source: 'external', sourceId: 'otr-quickstarts', repo: null, path: 'q_aaa0000001', url: null };
    const otrRaw = '# Quickstart\n\nRun `npm install acme`.\n';
    const otrText = otrRaw; // OTR already textified; docmend copies it through as-is
    const manifest = snapshotExternalPage(extRef, { kind: 'markdown', title: 'Quickstart', links: [] }, otrRaw, otrText, corpusDir);
    expect(manifest.kind).toBe('markdown');
    expect(manifest.title).toBe('Quickstart');
    expect(readManifestText(corpusDir, extRef.pageId)).toBe(otrText);
  });
});

describe('readManifests', () => {
  it('returns every committed manifest sorted by pageId, and [] when the dir is absent', () => {
    expect(readManifests(resolve(corpusDir, 'does-not-exist'))).toEqual([]);
    const refB: PageRef = { ...ownRef, pageId: 'zzz9999999' };
    const refA: PageRef = { ...ownRef, pageId: 'aaa1111111' };
    snapshotOwnRepoPage(refB, '# B\n', textifyMarkdown('# B\n', null), corpusDir);
    snapshotOwnRepoPage(refA, '# A\n', textifyMarkdown('# A\n', null), corpusDir);
    const all = readManifests(corpusDir);
    expect(all.map((m) => m.pageId)).toEqual(['aaa1111111', 'zzz9999999']);
  });
});

describe('assertNoPii over generated fixtures', () => {
  it('a manifest built from raw content carrying a personal profile URL is redacted clean', () => {
    const raw = '# Contact\n\nReach Ryan at https://www.linkedin.com/in/ryangarver or ryan@example.com.\n';
    const t = textifyMarkdown(raw, null);
    const manifest = snapshotOwnRepoPage(ownRef, raw, t, corpusDir);
    // The manifest we generate (not the raw page content) must never carry the identifier itself.
    assertNoPii(JSON.stringify(manifest), 'own-repo manifest', ['linkedin', 'email']);
  });
});
