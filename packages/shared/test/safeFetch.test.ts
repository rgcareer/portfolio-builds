import { describe, it, expect } from 'vitest';
import {
  isPrivateHost,
  toSafePublicHttpUrl,
  safeFetch,
  safeFetchText,
  readBodyCapped,
  DEFAULT_MAX_BYTES,
} from '../src/safeFetch';

function response(status: number, headers: Record<string, string> = {}, body: string | null = 'ok'): Response {
  return new Response(body, { status, headers });
}

describe('SSRF guard: host classification', () => {
  const unsafe = [
    'localhost',
    'LOCALHOST',
    'foo.localhost',
    'metadata.google.internal',
    'metadata',
    'db.internal',
    'printer.local',
    '127.0.0.1',
    '127.9.9.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    '[::1]',
    'fe80::1',
    'fd00::1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:7f00:1',
  ];
  for (const h of unsafe) {
    it(`refuses ${h}`, () => expect(isPrivateHost(h)).toBe(true));
  }
  const safe = ['example.com', 'docs.anthropic.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111'];
  for (const h of safe) {
    it(`allows ${h}`, () => expect(isPrivateHost(h)).toBe(false));
  }
});

describe('SSRF guard: URL admission', () => {
  it('refuses non-http schemes', () => {
    expect(toSafePublicHttpUrl('file:///etc/passwd')).toBeNull();
    expect(toSafePublicHttpUrl('ftp://example.com/x')).toBeNull();
    expect(toSafePublicHttpUrl('javascript:alert(1)')).toBeNull();
    expect(toSafePublicHttpUrl('not a url')).toBeNull();
  });
  it('refuses private targets and admits public ones', () => {
    expect(toSafePublicHttpUrl('http://127.0.0.1:8080/')).toBeNull();
    expect(toSafePublicHttpUrl('http://[::ffff:169.254.169.254]/latest/meta-data')).toBeNull();
    expect(toSafePublicHttpUrl('https://example.com/docs')?.href).toBe('https://example.com/docs');
  });
});

describe('safeFetch: redirect chain re-validation', () => {
  it('refuses a redirect that pivots to a private host', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return response(302, { location: 'http://127.0.0.1/admin' });
    }) as unknown as typeof fetch;
    const r = await safeFetch('https://example.com/start', {}, { fetchImpl });
    expect(r).toBeNull();
    expect(calls).toEqual(['https://example.com/start']);
  });

  it('follows public redirects and reports hops and final url', async () => {
    let n = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      n++;
      if (String(url) === 'https://example.com/a') return response(301, { location: '/b' });
      if (String(url) === 'https://example.com/b') return response(302, { location: 'https://docs.example.com/c' });
      return response(200, {}, 'final');
    }) as unknown as typeof fetch;
    const r = await safeFetch('https://example.com/a', {}, { fetchImpl });
    expect(r).not.toBeNull();
    expect(r!.hops).toBe(2);
    expect(r!.finalUrl).toBe('https://docs.example.com/c');
    expect(n).toBe(3);
  });

  it('stops at maxHops and returns the last redirect response', async () => {
    const fetchImpl = (async () => response(302, { location: '/loop' })) as unknown as typeof fetch;
    const r = await safeFetch('https://example.com/loop', {}, { fetchImpl, maxHops: 3 });
    expect(r).not.toBeNull();
    expect(r!.hops).toBe(3);
    expect(r!.res.status).toBe(302);
  });
});

describe('safeFetch: timeout', () => {
  it('aborts a fetch that never resolves once the deadline passes', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await safeFetchText('https://example.com/slow', { fetchImpl, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('readBodyCapped: byte cap', () => {
  function streamOf(chunkBytes: number, chunks: number): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i++ < chunks) controller.enqueue(new Uint8Array(chunkBytes));
        else controller.close();
      },
    });
  }
  it('refuses early on a declared Content-Length above the cap', async () => {
    const res = new Response('x', { headers: { 'content-length': String(DEFAULT_MAX_BYTES + 1) } });
    const r = await readBodyCapped(res, DEFAULT_MAX_BYTES);
    expect(r.ok).toBe(false);
  });
  it('refuses mid-stream once the running total exceeds the cap', async () => {
    const res = new Response(streamOf(1024 * 1024, 3)); // 3 MiB in 1 MiB chunks
    const r = await readBodyCapped(res, 2 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('body-too-large');
  });
  it('accepts a body at or under the cap and returns exact bytes', async () => {
    const res = new Response(streamOf(1000, 4));
    const r = await readBodyCapped(res, 4000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBe(4000);
  });
  it('safeFetchText surfaces the cap as a typed error', async () => {
    const fetchImpl = (async () => new Response(streamOf(1024 * 1024, 3), { status: 200 })) as unknown as typeof fetch;
    const r = await safeFetchText('https://example.com/big', { fetchImpl, maxBytes: 2 * 1024 * 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('body-too-large');
  });
  it('safeFetchText never throws on a fetch that throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const r = await safeFetchText('https://example.com/x', { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('network');
  });
});
