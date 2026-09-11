// Seed: the five frozen GitHub search queries, snapshotted verbatim (minimal fields) so the
// candidate ordering is reproducible after star counts move. Then the mechanical candidate
// list with its exclusion ledger.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeFetchText, sha256Hex, stableStringify, byteCompare, redactDeep } from '@portfolio-builds/shared';
import type { Protocol } from './protocol';

export interface SeedItem {
  full_name: string;
  owner: string;
  name: string;
  stars: number;
  html_url: string;
  homepage: string | null;
  archived: boolean;
  fork: boolean;
  topics: string[];
  default_branch: string;
  language: string | null;
  pushed_at: string | null;
}

export interface SeedFile {
  query: string;
  url: string;
  fetchedAt: string;
  status: number;
  total_count: number | null;
  sha256Raw: string;
  items: SeedItem[];
}

export interface Candidate extends SeedItem {
  id: string;
  rank: number;
  queries: string[];
}

export interface Exclusion {
  full_name: string;
  reason: string;
  detail?: string;
  stage: 'candidates' | 'snapshot';
  at: string;
}

export function candidateId(fullName: string): string {
  return 'q_' + sha256Hex(fullName).slice(0, 10);
}

function slug(q: string): string {
  return q.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchSeed(
  protocol: Protocol,
  cfg: { seedDir: string; fetchImpl?: typeof fetch; delayMs?: number; log?: (s: string) => void },
): Promise<{ files: string[]; failures: string[] }> {
  const { seed } = protocol.corpusRule;
  const ua = protocol.corpusRule.fetch.user_agent;
  mkdirSync(cfg.seedDir, { recursive: true });
  const files: string[] = [];
  const failures: string[] = [];
  for (const [i, q] of seed.queries.entries()) {
    const url = `${seed.endpoint}?q=${encodeURIComponent(q)}&sort=${seed.params.sort}&order=${seed.params.order}&per_page=${seed.params.per_page}&page=${seed.params.page}`;
    const fetchedAt = new Date().toISOString();
    const r = await safeFetchText(url, {
      timeoutMs: protocol.corpusRule.fetch.timeout_ms,
      maxBytes: 8 * 1024 * 1024,
      headers: { 'user-agent': ua, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
    });
    if (!r.ok || r.status !== 200) {
      failures.push(`${q}: ${r.ok ? `HTTP ${r.status}` : `${r.error} ${r.detail}`}`);
      cfg.log?.(`seed ${q}: FAILED ${failures[failures.length - 1]}`);
    } else {
      const j = JSON.parse(r.text) as { total_count?: number; items?: Record<string, unknown>[] };
      const items: SeedItem[] = (j.items ?? []).map((it) => ({
        full_name: String(it['full_name']),
        owner: String((it['owner'] as { login?: string } | undefined)?.login ?? String(it['full_name']).split('/')[0]),
        name: String(it['name']),
        stars: Number(it['stargazers_count'] ?? 0),
        html_url: String(it['html_url']),
        homepage: typeof it['homepage'] === 'string' && it['homepage'].trim() ? it['homepage'].trim() : null,
        archived: Boolean(it['archived']),
        fork: Boolean(it['fork']),
        topics: Array.isArray(it['topics']) ? (it['topics'] as string[]).map(String) : [],
        default_branch: String(it['default_branch'] ?? 'main'),
        language: typeof it['language'] === 'string' ? it['language'] : null,
        pushed_at: typeof it['pushed_at'] === 'string' ? it['pushed_at'] : null,
      }));
      // sha256Raw is over the unredacted response; the stored items are redacted (personal
      // profile URLs / emails in repo metadata), which never affects ordering or selection.
      const file: SeedFile = redactDeep({ query: q, url, fetchedAt, status: r.status, total_count: j.total_count ?? null, sha256Raw: sha256Hex(r.text), items });
      const path = resolve(cfg.seedDir, `${slug(q)}.json`);
      writeFileSync(path, stableStringify(file));
      files.push(path);
      cfg.log?.(`seed ${q}: ${items.length} items (total_count ${j.total_count ?? '?'})`);
    }
    if (i < seed.queries.length - 1) await sleep(cfg.delayMs ?? 7000); // unauthenticated search: 10 req/min
  }
  return { files, failures };
}

export function readSeed(seedDir: string): SeedFile[] {
  if (!existsSync(seedDir)) return [];
  return readdirSync(seedDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(seedDir, f), 'utf8')) as SeedFile);
}

/** The mechanical candidate list + exclusions, from committed seed files only. */
export function buildCandidates(seeds: SeedFile[], now: string): { candidates: Candidate[]; exclusions: Exclusion[] } {
  const byName = new Map<string, { item: SeedItem; queries: string[] }>();
  for (const s of seeds) {
    for (const it of s.items) {
      const cur = byName.get(it.full_name);
      if (cur) cur.queries.push(s.query);
      else byName.set(it.full_name, { item: it, queries: [s.query] });
    }
  }
  const ordered = [...byName.values()].sort((a, b) => b.item.stars - a.item.stars || byteCompare(a.item.full_name, b.item.full_name));
  const exclusions: Exclusion[] = [];
  const seenOwner = new Set<string>();
  const candidates: Candidate[] = [];
  for (const { item, queries } of ordered) {
    const ex = (reason: string, detail?: string) => exclusions.push({ full_name: item.full_name, reason, ...(detail ? { detail } : {}), stage: 'candidates', at: now });
    if (item.archived) {
      ex('archived');
      continue;
    }
    if (item.fork) {
      ex('fork');
      continue;
    }
    if (/^awesome[-_]/i.test(item.name) || item.topics.includes('awesome-list') || item.topics.includes('awesome')) {
      ex('awesome-list');
      continue;
    }
    const owner = item.owner.toLowerCase();
    if (seenOwner.has(owner)) {
      ex('duplicate-owner', `owner ${item.owner} already represented by a higher-ranked repository`);
      continue;
    }
    seenOwner.add(owner);
    candidates.push({ ...item, id: candidateId(item.full_name), rank: candidates.length + 1, queries: queries.slice().sort() });
  }
  return { candidates, exclusions };
}
