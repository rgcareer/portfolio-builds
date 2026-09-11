// External truth (npm, PyPI, link status) behind a committed JSON cache so that the
// analysis is a pure function of committed files. Mode "live" fills the cache through the
// SSRF-guarded fetch; mode "snapshot" (used by repro and tests) never touches the network
// and throws on a miss, which is exactly the failure a reviewer wants to see.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeFetch, safeFetchText, stableStringify } from '@portfolio-builds/shared';
import type { Lookup, RegistryInfo, LinkResult } from './l1';

export interface CacheEntry {
  fetchedAt: string;
  value: RegistryInfo | LinkResult;
}

export interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export type LookupMode = 'live' | 'snapshot';

export interface CachedLookupConfig {
  cachePath: string;
  mode: LookupMode;
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Called after each live fetch (progress). */
  onFetch?: (key: string) => void;
}

export class CachedLookup implements Lookup {
  private readonly cache: CacheFile;
  private dirty = false;
  constructor(private readonly cfg: CachedLookupConfig) {
    this.cache = existsSync(cfg.cachePath) ? (JSON.parse(readFileSync(cfg.cachePath, 'utf8')) as CacheFile) : { version: 1, entries: {} };
  }

  get size(): number {
    return Object.keys(this.cache.entries).length;
  }

  private async cached<T extends RegistryInfo | LinkResult>(key: string, fill: () => Promise<T>): Promise<T> {
    const hit = this.cache.entries[key];
    if (hit) return hit.value as T;
    if (this.cfg.mode === 'snapshot') throw new Error(`lookup cache miss in snapshot mode: ${key}`);
    const value = await fill();
    this.cache.entries[key] = { fetchedAt: new Date().toISOString(), value };
    this.dirty = true;
    this.cfg.onFetch?.(key);
    return value;
  }

  async npm(name: string): Promise<RegistryInfo> {
    return this.cached(`npm:${name}`, async () => {
      const url = `https://registry.npmjs.org/${name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;
      const r = await safeFetchText(url, {
        timeoutMs: this.cfg.timeoutMs,
        maxBytes: 8 * 1024 * 1024,
        headers: { 'user-agent': this.cfg.userAgent, accept: 'application/vnd.npm.install-v1+json' },
        ...(this.cfg.fetchImpl ? { fetchImpl: this.cfg.fetchImpl } : {}),
      });
      if (!r.ok) return { exists: r.error === 'body-too-large', latest: null, deprecated: false };
      if (r.status === 404) return { exists: false, latest: null, deprecated: false };
      if (r.status !== 200) return { exists: false, latest: null, deprecated: false };
      try {
        const j = JSON.parse(r.text) as { 'dist-tags'?: Record<string, string>; versions?: Record<string, { deprecated?: string | boolean }> };
        const latest = j['dist-tags']?.['latest'] ?? null;
        const deprecated = latest ? Boolean(j.versions?.[latest]?.deprecated) : false;
        return { exists: true, latest, deprecated };
      } catch {
        return { exists: true, latest: null, deprecated: false };
      }
    });
  }

  async pypi(name: string): Promise<RegistryInfo> {
    return this.cached(`pypi:${name}`, async () => {
      const r = await safeFetchText(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
        timeoutMs: this.cfg.timeoutMs,
        maxBytes: 8 * 1024 * 1024,
        headers: { 'user-agent': this.cfg.userAgent, accept: 'application/json' },
        ...(this.cfg.fetchImpl ? { fetchImpl: this.cfg.fetchImpl } : {}),
      });
      if (!r.ok) return { exists: r.error === 'body-too-large', latest: null, deprecated: false };
      if (r.status === 404) return { exists: false, latest: null, deprecated: false };
      if (r.status !== 200) return { exists: false, latest: null, deprecated: false };
      try {
        const j = JSON.parse(r.text) as { info?: { version?: string; yanked?: boolean } };
        return { exists: true, latest: j.info?.version ?? null, deprecated: Boolean(j.info?.yanked) };
      } catch {
        return { exists: true, latest: null, deprecated: false };
      }
    });
  }

  async link(url: string): Promise<LinkResult> {
    return this.cached(`link:${url}`, async () => {
      const attempt = async (): Promise<LinkResult> => {
        try {
          const r = await safeFetch(url, { headers: { 'user-agent': this.cfg.userAgent, accept: '*/*' } }, {
            timeoutMs: this.cfg.timeoutMs,
            ...(this.cfg.fetchImpl ? { fetchImpl: this.cfg.fetchImpl } : {}),
          });
          if (!r) return { status: null, ok: false, error: 'unsafe-url' };
          try {
            await r.res.body?.cancel();
          } catch {
            /* ignore */
          }
          return { status: r.res.status, ok: r.res.status >= 200 && r.res.status < 400, error: null };
        } catch (err) {
          const e = err as Error & { name?: string };
          return { status: null, ok: false, error: e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : `network: ${e.message}` };
        }
      };
      const first = await attempt();
      if (first.ok || first.status !== null) return first;
      return attempt(); // one retry on timeout/network, recorded as the final answer
    });
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.cfg.cachePath), { recursive: true });
    writeFileSync(this.cfg.cachePath, stableStringify(this.cache));
    this.dirty = false;
  }
}

/** In-memory lookup for tests. */
export function fakeLookup(data: { npm?: Record<string, RegistryInfo>; pypi?: Record<string, RegistryInfo>; links?: Record<string, LinkResult> }): Lookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async npm(name) {
      calls.push(`npm:${name}`);
      return data.npm?.[name] ?? { exists: false, latest: null, deprecated: false };
    },
    async pypi(name) {
      calls.push(`pypi:${name}`);
      return data.pypi?.[name] ?? { exists: false, latest: null, deprecated: false };
    },
    async link(url) {
      calls.push(`link:${url}`);
      return data.links?.[url] ?? { status: 200, ok: true, error: null };
    },
  };
}
