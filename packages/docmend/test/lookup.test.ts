import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { walkChain, HopAwareLookup, fakeLookup } from '../src/lookup';

function mockFetch(routes: Record<string, { status: number; location?: string }>, calls?: string[]): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url;
    calls?.push(url);
    const r = routes[url];
    if (!r) throw new Error(`mockFetch: no route for ${url}`);
    const headers = new Headers();
    if (r.location) headers.set('location', r.location);
    return new Response(null, { status: r.status, headers });
  }) as unknown as typeof fetch;
}

const CFG = { timeoutMs: 5000, userAgent: 'test-agent' };

describe('walkChain', () => {
  it('records a single-hop 200 with no redirect', async () => {
    const fetchImpl = mockFetch({ 'https://a.example/x': { status: 200 } });
    const r = await walkChain('https://a.example/x', { ...CFG, fetchImpl });
    expect(r.hops).toEqual([{ url: 'https://a.example/x', status: 200, location: null }]);
    expect(r.finalUrl).toBe('https://a.example/x');
    expect(r.finalStatus).toBe(200);
    expect(r.error).toBeNull();
  });

  it('follows a scheme-upgrade redirect (http -> https, same host) to 200', async () => {
    const fetchImpl = mockFetch({
      'http://a.example/x': { status: 301, location: 'https://a.example/x' },
      'https://a.example/x': { status: 200 },
    });
    const r = await walkChain('http://a.example/x', { ...CFG, fetchImpl });
    expect(r.hops.map((h) => h.status)).toEqual([301, 200]);
    expect(r.finalUrl).toBe('https://a.example/x');
    expect(r.finalStatus).toBe(200);
    expect(r.error).toBeNull();
  });

  it('classifies a chain needing a 6th fetch as too-many-hops, capped at 5 recorded hops', async () => {
    const routes: Record<string, { status: number; location?: string }> = {};
    for (let i = 0; i < 5; i++) routes[`https://a.example/${i}`] = { status: 301, location: `https://a.example/${i + 1}` };
    const fetchImpl = mockFetch(routes);
    const r = await walkChain('https://a.example/0', { ...CFG, fetchImpl });
    expect(r.hops).toHaveLength(5);
    expect(r.error).toBe('too-many-hops');
    expect(r.finalStatus).toBeNull();
  });

  it('returns unsafe-url when a redirect target is a private host', async () => {
    const fetchImpl = mockFetch({ 'https://a.example/x': { status: 302, location: 'http://169.254.169.254/latest' } });
    const r = await walkChain('https://a.example/x', { ...CFG, fetchImpl });
    expect(r.hops).toHaveLength(1);
    expect(r.error).toBe('unsafe-url');
  });

  it('records a 302 (temporary redirect) hop distinctly from a 301', async () => {
    const fetchImpl = mockFetch({
      'https://a.example/x': { status: 302, location: 'https://a.example/y' },
      'https://a.example/y': { status: 200 },
    });
    const r = await walkChain('https://a.example/x', { ...CFG, fetchImpl });
    expect(r.hops[0]!.status).toBe(302);
    expect(r.finalStatus).toBe(200);
  });
});

describe('HopAwareLookup', () => {
  const dir = resolve(__dirname, 'fixtures', 'lookup-cache-tmp');
  const cachePath = resolve(dir, 'cache.json');

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('snapshot mode throws on a cache miss', async () => {
    const lookup = new HopAwareLookup({ cachePath, mode: 'snapshot', userAgent: 'test', timeoutMs: 1000 });
    await expect(lookup.link('https://a.example/x')).rejects.toThrow(/cache miss in snapshot mode/);
  });

  it('live mode fetches once, caches, and a second call is a hit (no second fetch)', async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch({ 'https://a.example/x': { status: 200 } }, calls);
    const lookup = new HopAwareLookup({ cachePath, mode: 'live', userAgent: 'test', timeoutMs: 1000, fetchImpl });
    const first = await lookup.link('https://a.example/x');
    const second = await lookup.link('https://a.example/x');
    expect(first.finalStatus).toBe(200);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(lookup.size).toBe(1);
  });

  it('verify() uses a distinct cache namespace from the scan-time link()/npm()/pypi() calls', async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch({ 'https://a.example/x': { status: 200 } }, calls);
    const lookup = new HopAwareLookup({ cachePath, mode: 'live', userAgent: 'test', timeoutMs: 1000, fetchImpl });
    await lookup.link('https://a.example/x');
    await lookup.verify('link:https://a.example/x');
    // Two distinct cache entries (link:... and verify:link:...) => two independent fetches.
    expect(calls).toHaveLength(2);
    expect(lookup.size).toBe(2);
  });

  it('save() persists the cache to disk and a fresh instance reads it back', async () => {
    const fetchImpl = mockFetch({ 'https://a.example/x': { status: 200 } });
    const lookup = new HopAwareLookup({ cachePath, mode: 'live', userAgent: 'test', timeoutMs: 1000, fetchImpl });
    await lookup.link('https://a.example/x');
    lookup.save();
    expect(existsSync(cachePath)).toBe(true);
    const reloaded = new HopAwareLookup({ cachePath, mode: 'snapshot', userAgent: 'test', timeoutMs: 1000 });
    const r = await reloaded.link('https://a.example/x');
    expect(r.finalStatus).toBe(200);
  });
});

describe('registry lookups (npm/pypi)', () => {
  const dir = resolve(__dirname, 'fixtures', 'lookup-registry-tmp');
  const cachePath = resolve(dir, 'cache.json');
  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('npm() reports latest, versions[], and deprecatedVersions from the registry JSON', async () => {
    const body = JSON.stringify({
      'dist-tags': { latest: '2.0.0' },
      versions: { '1.0.0': {}, '1.5.0': { deprecated: 'use 2.x' }, '2.0.0': {} },
    });
    const fetchImpl = (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const lookup = new HopAwareLookup({ cachePath, mode: 'live', userAgent: 'test', timeoutMs: 1000, fetchImpl });
    const info = await lookup.npm('some-pkg');
    expect(info.exists).toBe(true);
    expect(info.latest).toBe('2.0.0');
    expect(info.versions.sort()).toEqual(['1.0.0', '1.5.0', '2.0.0']);
    expect(info.deprecatedVersions).toEqual(['1.5.0']);
    expect(info.deprecated).toBe(false);
  });

  it('pypi() normalizes the package name (PEP 503) before requesting', async () => {
    const calls: string[] = [];
    const body = JSON.stringify({ info: { version: '3.1.0' }, releases: { '3.1.0': [{ yanked: false }] } });
    const fetchImpl = (async (input: unknown) => {
      calls.push(typeof input === 'string' ? input : (input as { url: string }).url);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const lookup = new HopAwareLookup({ cachePath, mode: 'live', userAgent: 'test', timeoutMs: 1000, fetchImpl });
    await lookup.pypi('My_Package.Name');
    expect(calls[0]).toContain('my-package-name');
  });
});

describe('fakeLookup', () => {
  it('returns configured values and records calls', async () => {
    const lookup = fakeLookup({
      links: { 'https://a.example/x': { kind: 'chain', hops: [{ url: 'https://a.example/x', status: 200, location: null }], finalUrl: 'https://a.example/x', finalStatus: 200, error: null } },
    });
    const r = await lookup.link('https://a.example/x');
    expect(r.finalStatus).toBe(200);
    expect(lookup.calls).toContain('link:https://a.example/x');
  });
});
