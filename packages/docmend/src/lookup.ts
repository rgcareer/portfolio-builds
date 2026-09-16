// External truth behind a committed JSON cache, so analysis (checks.ts, reverify.ts) is a
// pure function of committed files. Mode "live" fills the cache through the SSRF-guarded
// fetch; mode "snapshot" (repro, tests) never touches the network and throws on a miss.
//
// Unlike onboarding-transfer-rate's CachedLookup (which only records pass/fail per link),
// HopAwareLookup walks and records every redirect hop itself — {url, status, location} per
// hop, plus the final URL — because docmend's redirect-rewrite proposal needs the whole
// chain to classify safety (scheme upgrade vs cross-host, 301/308 vs 302/307, hop count).
// A `verify:`-prefixed key is a second, independent cache namespace: reverify.ts calls
// lookup.verify(key) to re-derive a proposal's truth from scratch, never reading the
// scan-time cache entry the proposal itself was built from.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeFetch, safeFetchText, stableStringify } from '@portfolio-builds/shared';
import { normalizePypi } from './snippets';

export interface HopRecord {
  url: string;
  status: number | null;
  location: string | null;
}

export interface ChainResult {
  kind: 'chain';
  hops: HopRecord[];
  finalUrl: string;
  finalStatus: number | null;
  error: string | null;
}

export interface RegistryInfo {
  kind: 'registry';
  exists: boolean;
  latest: string | null;
  deprecated: boolean;
  versions: string[];
  deprecatedVersions: string[];
}

export type LookupValue = ChainResult | RegistryInfo;

export interface Lookup {
  link(url: string): Promise<ChainResult>;
  npm(name: string): Promise<RegistryInfo>;
  pypi(name: string): Promise<RegistryInfo>;
  /** Independent re-fetch for reverify: key is "link:<url>" | "npm:<name>" | "pypi:<name>". */
  verify(key: string): Promise<LookupValue>;
}

export const MAX_HOPS = 5;

export interface ChainConfig {
  timeoutMs: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

function classifyError(err: unknown): string {
  const e = err as Error & { name?: string };
  return e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : `network: ${e?.message ?? String(err)}`;
}

/** Manually walks a redirect chain up to MAX_HOPS, recording every hop's status/location. */
export async function walkChain(rawUrl: string, cfg: ChainConfig): Promise<ChainResult> {
  const hops: HopRecord[] = [];
  let current = rawUrl;
  for (let i = 0; i < MAX_HOPS; i++) {
    let r;
    try {
      r = await safeFetch(
        current,
        { headers: { 'user-agent': cfg.userAgent, accept: '*/*' } },
        { maxHops: 0, timeoutMs: cfg.timeoutMs, ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}) },
      );
    } catch (err) {
      return { kind: 'chain', hops, finalUrl: current, finalStatus: null, error: classifyError(err) };
    }
    if (!r) {
      return { kind: 'chain', hops, finalUrl: current, finalStatus: null, error: 'unsafe-url' };
    }
    const status = r.res.status;
    const location = r.res.headers.get('location');
    hops.push({ url: current, status, location });
    try {
      await r.res.body?.cancel();
    } catch {
      /* ignore */
    }
    const isRedirect = status >= 300 && status < 400 && Boolean(location);
    if (!isRedirect) {
      return { kind: 'chain', hops, finalUrl: current, finalStatus: status, error: null };
    }
    try {
      current = new URL(location!, current).href;
    } catch {
      return { kind: 'chain', hops, finalUrl: current, finalStatus: status, error: 'bad-location' };
    }
  }
  return { kind: 'chain', hops, finalUrl: current, finalStatus: null, error: 'too-many-hops' };
}

async function fetchNpm(name: string, cfg: ChainConfig): Promise<RegistryInfo> {
  const url = `https://registry.npmjs.org/${name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;
  const r = await safeFetchText(url, {
    timeoutMs: cfg.timeoutMs,
    maxBytes: 8 * 1024 * 1024,
    headers: { 'user-agent': cfg.userAgent, accept: 'application/vnd.npm.install-v1+json' },
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  });
  const empty: RegistryInfo = { kind: 'registry', exists: false, latest: null, deprecated: false, versions: [], deprecatedVersions: [] };
  if (!r.ok || r.status === 404 || r.status !== 200) return empty;
  try {
    const j = JSON.parse(r.text) as { 'dist-tags'?: Record<string, string>; versions?: Record<string, { deprecated?: string | boolean }> };
    const latest = j['dist-tags']?.['latest'] ?? null;
    const versions = Object.keys(j.versions ?? {});
    const deprecatedVersions = versions.filter((v) => Boolean(j.versions?.[v]?.deprecated));
    const deprecated = latest ? deprecatedVersions.includes(latest) : false;
    return { kind: 'registry', exists: true, latest, deprecated, versions, deprecatedVersions };
  } catch {
    return { kind: 'registry', exists: true, latest: null, deprecated: false, versions: [], deprecatedVersions: [] };
  }
}

async function fetchPypi(name: string, cfg: ChainConfig): Promise<RegistryInfo> {
  const r = await safeFetchText(`https://pypi.org/pypi/${encodeURIComponent(normalizePypi(name))}/json`, {
    timeoutMs: cfg.timeoutMs,
    maxBytes: 8 * 1024 * 1024,
    headers: { 'user-agent': cfg.userAgent, accept: 'application/json' },
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  });
  const empty: RegistryInfo = { kind: 'registry', exists: false, latest: null, deprecated: false, versions: [], deprecatedVersions: [] };
  if (!r.ok || r.status === 404 || r.status !== 200) return empty;
  try {
    const j = JSON.parse(r.text) as { info?: { version?: string; yanked?: boolean }; releases?: Record<string, { yanked?: boolean }[]> };
    const latest = j.info?.version ?? null;
    const versions = Object.keys(j.releases ?? {});
    const deprecatedVersions = versions.filter((v) => (j.releases?.[v] ?? []).some((f) => f.yanked));
    const deprecated = Boolean(j.info?.yanked) || (latest ? deprecatedVersions.includes(latest) : false);
    return { kind: 'registry', exists: true, latest, deprecated, versions, deprecatedVersions };
  } catch {
    return { kind: 'registry', exists: true, latest: null, deprecated: false, versions: [], deprecatedVersions: [] };
  }
}

export interface CacheEntry {
  fetchedAt: string;
  value: LookupValue;
}

export interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export type LookupMode = 'live' | 'snapshot';

export interface HopAwareLookupConfig {
  cachePath: string;
  mode: LookupMode;
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  onFetch?: (key: string) => void;
}

export class HopAwareLookup implements Lookup {
  private readonly cache: CacheFile;
  private dirty = false;

  constructor(private readonly cfg: HopAwareLookupConfig) {
    this.cache = existsSync(cfg.cachePath) ? (JSON.parse(readFileSync(cfg.cachePath, 'utf8')) as CacheFile) : { version: 1, entries: {} };
  }

  get size(): number {
    return Object.keys(this.cache.entries).length;
  }

  private chainCfg(): ChainConfig {
    const base: ChainConfig = { timeoutMs: this.cfg.timeoutMs, userAgent: this.cfg.userAgent };
    return this.cfg.fetchImpl ? { ...base, fetchImpl: this.cfg.fetchImpl } : base;
  }

  private async cached<T extends LookupValue>(key: string, fill: () => Promise<T>): Promise<T> {
    const hit = this.cache.entries[key];
    if (hit) return hit.value as T;
    if (this.cfg.mode === 'snapshot') throw new Error(`lookup cache miss in snapshot mode: ${key}`);
    const value = await fill();
    this.cache.entries[key] = { fetchedAt: new Date().toISOString(), value };
    this.dirty = true;
    this.cfg.onFetch?.(key);
    return value;
  }

  async link(url: string): Promise<ChainResult> {
    return this.cached(`link:${url}`, () => walkChain(url, this.chainCfg()));
  }

  async npm(name: string): Promise<RegistryInfo> {
    return this.cached(`npm:${name}`, () => fetchNpm(name, this.chainCfg()));
  }

  async pypi(name: string): Promise<RegistryInfo> {
    return this.cached(`pypi:${normalizePypi(name)}`, () => fetchPypi(name, this.chainCfg()));
  }

  async verify(key: string): Promise<LookupValue> {
    return this.cached(`verify:${key}`, () => this.resolveFresh(key));
  }

  private async resolveFresh(key: string): Promise<LookupValue> {
    const i = key.indexOf(':');
    if (i < 0) throw new Error(`lookup.verify: malformed key ${key}`);
    const kind = key.slice(0, i);
    const rest = key.slice(i + 1);
    if (kind === 'link') return walkChain(rest, this.chainCfg());
    if (kind === 'npm') return fetchNpm(rest, this.chainCfg());
    if (kind === 'pypi') return fetchPypi(rest, this.chainCfg());
    throw new Error(`lookup.verify: unknown kind ${kind}`);
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.cfg.cachePath), { recursive: true });
    writeFileSync(this.cfg.cachePath, stableStringify(this.cache));
    this.dirty = false;
  }
}

export interface FakeLookupData {
  links?: Record<string, ChainResult>;
  npm?: Record<string, RegistryInfo>;
  pypi?: Record<string, RegistryInfo>;
}

const EMPTY_CHAIN = (url: string): ChainResult => ({ kind: 'chain', hops: [{ url, status: 200, location: null }], finalUrl: url, finalStatus: 200, error: null });
const EMPTY_REGISTRY: RegistryInfo = { kind: 'registry', exists: false, latest: null, deprecated: false, versions: [], deprecatedVersions: [] };

/** In-memory Lookup for tests. verify() reads the same fixture data (independent in code path, not in fixture). */
export function fakeLookup(data: FakeLookupData): Lookup & { calls: string[] } {
  const calls: string[] = [];
  const impl: Lookup = {
    async link(url) {
      calls.push(`link:${url}`);
      return data.links?.[url] ?? EMPTY_CHAIN(url);
    },
    async npm(name) {
      calls.push(`npm:${name}`);
      return data.npm?.[name] ?? EMPTY_REGISTRY;
    },
    async pypi(name) {
      calls.push(`pypi:${normalizePypi(name)}`);
      return data.pypi?.[normalizePypi(name)] ?? EMPTY_REGISTRY;
    },
    async verify(key) {
      calls.push(`verify:${key}`);
      const i = key.indexOf(':');
      const kind = key.slice(0, i);
      const rest = key.slice(i + 1);
      if (kind === 'link') return impl.link(rest);
      if (kind === 'npm') return impl.npm(rest);
      if (kind === 'pypi') return impl.pypi(rest);
      throw new Error(`fakeLookup.verify: unknown kind ${kind}`);
    },
  };
  return { ...impl, calls };
}
