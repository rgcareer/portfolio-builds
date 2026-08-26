import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  seededSample,
  stableStringify,
  sha256Canonical,
  pct,
  byteCompare,
  normalizePathNfc,
  isPrivateHost,
  isPrivateIpv4,
  toSafePublicHttpUrl,
  safeFetch,
  parseFrontmatter,
} from '@skillcheck/core';

describe('prng — mulberry32', () => {
  it('matches the pinned seed-7 known-answer stream', () => {
    const r = mulberry32(7);
    const draws = [r(), r(), r(), r(), r()];
    expect(draws).toEqual([
      0.011704753153026104, 0.06195825757458806, 0.97690763277933, 0.6990287057124078,
      0.5214452685322613,
    ]);
  });

  it('is a pure function of the seed', () => {
    const a = Array.from({ length: 8 }, mulberry32(42));
    const b = Array.from({ length: 8 }, mulberry32(42));
    const c = Array.from({ length: 8 }, mulberry32(43));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('seededSample is deterministic and a subset', () => {
    const pool = Array.from({ length: 20 }, (_, i) => i);
    expect(seededSample(pool, 5, 7)).toEqual([0, 2, 19, 14, 12]);
    expect(seededSample(pool, 5, 7)).toEqual(seededSample(pool, 5, 7));
    expect(seededSample(pool, 100, 7)).toHaveLength(20); // clamped to pool size
  });
});

describe('stableStringify + hashing', () => {
  it('is key-order independent, sorted, LF, trailing newline', () => {
    const s = stableStringify({ b: 1, a: 2 });
    expect(s).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(s.endsWith('\n')).toBe(true);
    expect(s).not.toContain('\r');
  });

  it('sorts nested keys but preserves array order', () => {
    const s = stableStringify({ z: [3, 1, 2], a: { y: 1, x: 2 } });
    expect(s.indexOf('"a"')).toBeLessThan(s.indexOf('"z"'));
    expect(s.indexOf('"x"')).toBeLessThan(s.indexOf('"y"'));
    expect(s).toContain('[\n    3,\n    1,\n    2\n  ]'); // array not reordered
  });

  it('hashes independent of key order', () => {
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }));
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
  });
});

describe('pct / byteCompare / nfc', () => {
  it('pct is two-decimal, integer-based, zero-safe', () => {
    expect(pct(1, 3)).toBe(33.33);
    expect(pct(2, 4)).toBe(50);
    expect(pct(1, 8)).toBe(12.5);
    expect(pct(10, 10)).toBe(100);
    expect(pct(0, 0)).toBe(0);
  });

  it('byteCompare orders like SQLite BINARY', () => {
    expect(byteCompare('a', 'b')).toBeLessThan(0);
    expect(byteCompare('b', 'a')).toBeGreaterThan(0);
    expect(byteCompare('a', 'a')).toBe(0);
    expect(['c', 'a', 'b'].slice().sort(byteCompare)).toEqual(['a', 'b', 'c']);
  });

  it('normalizePathNfc composes decomposed sequences', () => {
    expect(normalizePathNfc('café')).toBe('café');
    expect(normalizePathNfc('café')).toHaveLength(4);
  });
});

describe('safeFetch SSRF guard', () => {
  const privateHosts = [
    'localhost',
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    'metadata',
    'metadata.google.internal',
    'foo.localhost',
    'foo.internal',
    'foo.local',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe', // hex form of 169.254.169.254
  ];
  const publicHosts = ['8.8.8.8', '93.184.216.34', 'example.com', 'github.com', '172.32.0.1'];

  it('classifies private vs public hosts', () => {
    for (const h of privateHosts) expect(isPrivateHost(h), h).toBe(true);
    for (const h of publicHosts) expect(isPrivateHost(h), h).toBe(false);
  });

  it('isPrivateIpv4 boundary cases', () => {
    expect(isPrivateIpv4('172.15.0.1')).toBe(false);
    expect(isPrivateIpv4('172.16.0.1')).toBe(true);
    expect(isPrivateIpv4('100.63.0.1')).toBe(false);
    expect(isPrivateIpv4('100.64.0.1')).toBe(true);
  });

  it('toSafePublicHttpUrl rejects unsafe schemes and hosts', () => {
    for (const raw of [
      'http://127.0.0.1/',
      'https://169.254.169.254/latest/meta-data/',
      'ftp://example.com/',
      'file:///etc/passwd',
      'http://metadata/computeMetadata/v1/',
      'http://[::1]/',
      'not a url',
    ]) {
      expect(toSafePublicHttpUrl(raw), raw).toBeNull();
    }
    expect(toSafePublicHttpUrl('https://example.com/x')?.hostname).toBe('example.com');
  });

  // --- redirect revalidation (mocked fetch) ---
  function redirect(location: string, status = 302): Response {
    return {
      status,
      headers: { has: (k: string) => k === 'location', get: (k: string) => (k === 'location' ? location : null) },
    } as unknown as Response;
  }
  function ok(status = 200): Response {
    return { status, headers: { has: () => false, get: () => null } } as unknown as Response;
  }
  function scripted(script: (href: string) => Response) {
    const hrefs: string[] = [];
    const impl = (async (href: string) => {
      hrefs.push(String(href));
      return script(String(href));
    }) as unknown as typeof fetch;
    return { impl, hrefs };
  }

  it('returns a direct response with hops=0', async () => {
    const s = scripted(() => ok());
    const out = await safeFetch('https://example.com/', {}, { fetchImpl: s.impl });
    expect(out?.hops).toBe(0);
    expect(s.hrefs).toEqual(['https://example.com/']);
  });

  it('refuses the whole chain when a redirect points at metadata', async () => {
    const s = scripted(() => redirect('http://169.254.169.254/'));
    const out = await safeFetch('https://example.com/', {}, { fetchImpl: s.impl });
    expect(out).toBeNull();
    expect(s.hrefs).toEqual(['https://example.com/']); // never fetched the metadata host
  });

  it('follows a safe public redirect chain and counts hops', async () => {
    const s = scripted((href) => {
      if (href === 'https://a.test/') return redirect('https://b.test/');
      if (href === 'https://b.test/') return redirect('https://c.test/');
      return ok();
    });
    const out = await safeFetch('https://a.test/', {}, { fetchImpl: s.impl });
    expect(out?.hops).toBe(2);
    expect(s.hrefs).toEqual(['https://a.test/', 'https://b.test/', 'https://c.test/']);
  });

  it('stops at maxHops without following further', async () => {
    const s = scripted((href) =>
      href === 'https://a.test/' ? redirect('https://b.test/') : redirect('https://c.test/'),
    );
    const out = await safeFetch('https://a.test/', {}, { fetchImpl: s.impl, maxHops: 1 });
    expect(out?.hops).toBe(1);
    expect(s.hrefs).toEqual(['https://a.test/', 'https://b.test/']);
  });
});

describe('frontmatter validator (single source of truth)', () => {
  it('accepts a well-formed SKILL.md and extracts the body', () => {
    const r = parseFrontmatter('---\nname: my-skill\ndescription: Does a thing\n---\n\n# Body\ntext\n');
    expect(r.valid).toBe(true);
    expect(r.frontmatter?.name).toBe('my-skill');
    expect(r.body).toBe('\n# Body\ntext\n');
  });

  it('rejects missing name or description', () => {
    expect(parseFrontmatter('---\ndescription: only desc\n---\nx').valid).toBe(false);
    expect(parseFrontmatter('---\nname: only-name\n---\nx').valid).toBe(false);
    expect(parseFrontmatter('---\nname: n\ndescription: "  "\n---\nx').valid).toBe(false);
  });

  it('rejects no frontmatter, malformed YAML, non-mapping', () => {
    expect(parseFrontmatter('# Just a heading, no frontmatter').valid).toBe(false);
    expect(parseFrontmatter('---\nname: [unclosed\n---\nx').valid).toBe(false);
    expect(parseFrontmatter('---\njust a scalar\n---\nx').valid).toBe(false);
    expect(parseFrontmatter('---\n- a\n- b\n---\nx').valid).toBe(false); // array
  });

  it('tolerates a leading BOM', () => {
    expect(parseFrontmatter('﻿---\nname: n\ndescription: d\n---\n').valid).toBe(true);
  });
});
