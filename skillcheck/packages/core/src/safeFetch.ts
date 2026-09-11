// SSRF guard for outbound fetches built from externally-sourced data — ported from
// operation-hired/server/utils/safeFetch.js. In Skillcheck it guards every URL that
// originated INSIDE harvested content (registry README links, marketplace entries,
// off-GitHub redirects): attacker-influenced targets that must never reach loopback,
// private, link-local, or cloud-metadata endpoints.
//
// Blocks non-http(s) schemes and private/loopback/link-local/metadata hosts, including
// IPv4-mapped IPv6 bypasses, and re-validates EVERY redirect hop. As in OH, DNS-rebinding
// defense (resolve + re-check the resolved IP) is out of scope, and callers own the
// timeout + response-size cap (pass AbortSignal.timeout(...) and stream with a byte cap).

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
 * Extract the trailing 32 bits and re-check them as IPv4.
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

export interface SafeFetchResult {
  res: Response;
  hops: number;
}

export interface SafeFetchConfig {
  maxHops?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch that re-checks EVERY redirect hop against the SSRF guard. Follows redirects
 * manually (`redirect: 'manual'`) and re-validates each Location before continuing;
 * refuses the whole chain (returns null) if the target or any hop is unsafe.
 */
export async function safeFetch(
  rawUrl: string,
  options: RequestInit = {},
  config: SafeFetchConfig = {},
): Promise<SafeFetchResult | null> {
  const { maxHops = 5, fetchImpl = fetch } = config;
  let safe = toSafePublicHttpUrl(rawUrl);
  if (!safe) return null;
  for (let hops = 0; ; hops++) {
    const res = await fetchImpl(safe.href, { ...options, redirect: 'manual' });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
    if (!isRedirect || hops >= maxHops) return { res, hops };
    let nextRaw: string;
    try {
      nextRaw = new URL(res.headers.get('location')!, safe.href).href;
    } catch {
      return null;
    }
    const next = toSafePublicHttpUrl(nextRaw);
    if (!next) return null; // redirect points at an unsafe host → refuse the whole chain
    safe = next;
  }
}
