// SSRF guard for outbound fetches built from externally-sourced data.
//
// Provenance: vendored 2026-09-10 from skillcheck/packages/core/src/safeFetch.ts, itself a
// port of operation-hired/server/utils/safeFetch.js. Two additions here that neither
// ancestor had: an overall timeout (AbortSignal.timeout) and a streamed response-size cap.
// DNS-rebinding defense (resolve, then re-check the resolved IP) remains out of scope and
// is stated as such in every piece README.

const PRIVATE_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata']);

export function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

/**
 * An IPv4-mapped/compatible IPv6 literal (::ffff:169.254.169.254 or its ::ffff:a9fe:a9fe
 * hex form) serializes past the plain-IPv4 regex but resolves to the embedded v4 address.
 */
export function ipv4MappedToDotted(h: string): string | null {
  const dotted = /^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (PRIVATE_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }
  const mapped = ipv4MappedToDotted(h);
  if (mapped && isPrivateIpv4(mapped)) return true;
  if (isPrivateIpv4(h)) return true;
  return false;
}

/** A URL object if the target is a safe public http(s) endpoint, otherwise null. */
export function toSafePublicHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || isPrivateHost(u.hostname)) return null;
  return u;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

export interface SafeFetchResult {
  res: Response;
  hops: number;
  finalUrl: string;
}

export interface SafeFetchConfig {
  maxHops?: number;
  /** Overall deadline for the whole redirect chain. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch that re-checks EVERY redirect hop against the SSRF guard. Follows redirects
 * manually and re-validates each Location before continuing; refuses the whole chain
 * (returns null) if the target or any hop is unsafe. One AbortSignal.timeout covers the
 * whole chain. Throws only what fetch itself throws (abort, network); callers that must
 * never throw wrap it (see safeFetchText).
 */
export async function safeFetch(
  rawUrl: string,
  options: RequestInit = {},
  config: SafeFetchConfig = {},
): Promise<SafeFetchResult | null> {
  const { maxHops = 5, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = config;
  let safe = toSafePublicHttpUrl(rawUrl);
  if (!safe) return null;
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
  for (let hops = 0; ; hops++) {
    const res = await fetchImpl(safe.href, { ...options, signal, redirect: 'manual' });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
    if (!isRedirect || hops >= maxHops) return { res, hops, finalUrl: safe.href };
    let nextRaw: string;
    try {
      nextRaw = new URL(res.headers.get('location')!, safe.href).href;
    } catch {
      return null;
    }
    const next = toSafePublicHttpUrl(nextRaw);
    if (!next) return null; // redirect points at an unsafe host -> refuse the whole chain
    safe = next;
  }
}

export type BodyCapResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'body-too-large' | 'no-body' };

/**
 * Read a response body while enforcing a byte cap. Refuses early on a declared
 * Content-Length above the cap, and refuses mid-stream the moment the running total
 * exceeds it (cancelling the stream). Never buffers more than maxBytes + one chunk.
 */
export async function readBodyCapped(res: Response, maxBytes: number = DEFAULT_MAX_BYTES): Promise<BodyCapResult> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'body-too-large' };
  if (!res.body) return { ok: false, reason: 'no-body' };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return { ok: false, reason: 'body-too-large' };
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, bytes: out };
}

export interface SafeFetchTextConfig extends SafeFetchConfig {
  maxBytes?: number;
  headers?: Record<string, string>;
}

export type SafeFetchTextResult =
  | { ok: true; text: string; status: number; hops: number; finalUrl: string; bytes: number; contentType: string | null }
  | { ok: false; error: 'unsafe-url' | 'body-too-large' | 'no-body' | 'timeout' | 'network'; detail: string; status?: number; finalUrl?: string };

/**
 * Never-throws convenience: SSRF-guarded fetch + timeout + byte cap, decoded as UTF-8.
 * Returns a discriminated result so callers record the failure class as a finding.
 */
export async function safeFetchText(rawUrl: string, config: SafeFetchTextConfig = {}): Promise<SafeFetchTextResult> {
  const { maxBytes = DEFAULT_MAX_BYTES, headers = {}, ...fetchCfg } = config;
  try {
    const r = await safeFetch(rawUrl, { headers }, fetchCfg);
    if (!r) return { ok: false, error: 'unsafe-url', detail: rawUrl };
    const body = await readBodyCapped(r.res, maxBytes);
    if (!body.ok) return { ok: false, error: body.reason, detail: `cap ${maxBytes} bytes`, status: r.res.status, finalUrl: r.finalUrl };
    return {
      ok: true,
      text: new TextDecoder('utf-8').decode(body.bytes),
      status: r.res.status,
      hops: r.hops,
      finalUrl: r.finalUrl,
      bytes: body.bytes.byteLength,
      contentType: r.res.headers.get('content-type'),
    };
  } catch (err) {
    const e = err as Error & { name?: string };
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'timeout' : 'network', detail: e.message ?? String(err) };
  }
}
