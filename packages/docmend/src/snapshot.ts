// Writes one snapshot per page: data/corpus/<pageId>/{raw.md|raw.html, text.txt,
// manifest.json}. The textified form (from textify.ts) is what every downstream check reads
// — checks.ts, analyze.ts — so analysis is a pure function of these committed files, never
// of a live fetch. Manifests never carry personal-profile URLs or emails (redactDeep).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256Hex, stableStringify, redactDeep, byteCompare } from '@portfolio-builds/shared';
import type { PageRef, PageSourceKind } from './types';
import type { Textified } from './textify';

export interface Manifest {
  pageId: string;
  source: PageSourceKind;
  sourceId: string;
  repo: string | null;
  path: string;
  url: string | null;
  kind: 'html' | 'markdown';
  rawFile: string;
  bytes: number;
  sha256Raw: string;
  sha256Text: string;
  title: string | null;
  links: string[];
  fetchedAt: string;
}

export function writeSnapshot(corpusDir: string, ref: PageRef, kind: 'html' | 'markdown', raw: string, textified: Pick<Textified, 'text' | 'title' | 'links'>): Manifest {
  const dir = resolve(corpusDir, ref.pageId);
  mkdirSync(dir, { recursive: true });
  const rawFile = kind === 'html' ? 'raw.html' : 'raw.md';
  writeFileSync(resolve(dir, rawFile), raw);
  writeFileSync(resolve(dir, 'text.txt'), textified.text);
  const manifest: Manifest = {
    pageId: ref.pageId,
    source: ref.source,
    sourceId: ref.sourceId,
    repo: ref.repo,
    path: ref.path,
    url: ref.url,
    kind,
    rawFile,
    bytes: Buffer.byteLength(raw, 'utf8'),
    sha256Raw: sha256Hex(raw),
    sha256Text: sha256Hex(textified.text),
    title: textified.title,
    links: textified.links,
    fetchedAt: new Date().toISOString(),
  };
  // Raw and text stay verbatim (source content); the manifest we generate never carries a
  // personal-profile URL or email.
  const redacted = redactDeep(manifest);
  writeFileSync(resolve(dir, 'manifest.json'), stableStringify(redacted));
  return redacted;
}

/** An own-repo markdown file: raw content textified with textifyMarkdown by the caller. */
export function snapshotOwnRepoPage(ref: PageRef, raw: string, textified: Pick<Textified, 'text' | 'title' | 'links'>, corpusDir: string): Manifest {
  return writeSnapshot(corpusDir, ref, 'markdown', raw, textified);
}

/** A crawled getsmartai.ai page: raw HTML textified with textifyHtml by the caller. */
export function snapshotSitePage(ref: PageRef, raw: string, textified: Pick<Textified, 'text' | 'title' | 'links'>, corpusDir: string): Manifest {
  return writeSnapshot(corpusDir, ref, 'html', raw, textified);
}

/**
 * An external quickstart already textified by onboarding-transfer-rate: docmend copies its
 * committed raw + text through (no re-fetch — OTR's corpus IS the external truth here).
 */
export function snapshotExternalPage(
  ref: PageRef,
  otr: { kind: 'html' | 'markdown'; title: string | null; links: string[] },
  otrRaw: string,
  otrText: string,
  corpusDir: string,
): Manifest {
  return writeSnapshot(corpusDir, ref, otr.kind, otrRaw, { text: otrText, title: otr.title, links: otr.links });
}

export function corpusHas(corpusDir: string, pageId: string): boolean {
  return existsSync(resolve(corpusDir, pageId, 'manifest.json'));
}

export function readManifest(corpusDir: string, pageId: string): Manifest {
  return JSON.parse(readFileSync(resolve(corpusDir, pageId, 'manifest.json'), 'utf8')) as Manifest;
}

export function readManifestText(corpusDir: string, pageId: string): string {
  return readFileSync(resolve(corpusDir, pageId, 'text.txt'), 'utf8');
}

/** Every committed manifest, sorted by pageId (bytewise) for determinism. */
export function readManifests(corpusDir: string): Manifest[] {
  if (!existsSync(corpusDir)) return [];
  return readdirSync(corpusDir)
    .filter((d) => existsSync(resolve(corpusDir, d, 'manifest.json')))
    .sort(byteCompare)
    .map((d) => readManifest(corpusDir, d));
}
