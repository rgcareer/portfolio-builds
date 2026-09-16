import { describe, it, expect } from 'vitest';
import { classifyRedirectSafety, proposeRedirectRewrite, proposePinBump, proposePathRewrite } from '../src/propose';
import type { ChainResult } from '../src/lookup';
import type { Finding, ProposalTarget } from '../src/types';

const TARGET: ProposalTarget = { kind: 'repo-file', repo: 'repo-a', path: 'README.md', prReady: true };

function redirectFinding(url: string, chain: ChainResult, excerpt?: string): Finding {
  return {
    id: 'f1',
    pageId: 'p1',
    checkId: 'D-redirect',
    category: 'redirected-link',
    line: 3,
    excerpt: excerpt ?? `See ${url} for more.`,
    detail: 'redirects',
    counted: true,
    evidence: { url, chain },
  };
}

function chain(finalStatus: number, finalUrl: string, hops: Array<{ status: number }>): ChainResult {
  return { kind: 'chain', hops: hops.map((h, i) => ({ url: `https://x.example/${i}`, status: h.status, location: null })), finalUrl, finalStatus, error: null };
}

describe('chain classification: redirect-rewrite safety', () => {
  it('scheme upgrade (http -> https, same host, all 301) is safe', () => {
    const c = chain(200, 'https://a.example/docs', [{ status: 301 }, { status: 200 }]);
    const safety = classifyRedirectSafety('http://a.example/docs', c);
    expect(safety.status).toBe('safe');
  });

  it('a root redirect (original path "/") is flag-only, never a proposal', () => {
    const c = chain(200, 'https://a.example/home', [{ status: 301 }, { status: 200 }]);
    const safety = classifyRedirectSafety('https://a.example/', c);
    expect(safety.status).toBe('flag');

    const finding = redirectFinding('https://a.example/', c, 'See https://a.example/ for more.');
    const proposal = proposeRedirectRewrite(finding, 'raw text with https://a.example/ in it\n', TARGET);
    expect(proposal).toBeNull();
  });

  it('a cross-host permanent redirect is proposed but unsafe', () => {
    const c = chain(200, 'https://other.example/docs', [{ status: 301 }, { status: 200 }]);
    const safety = classifyRedirectSafety('https://a.example/docs', c);
    expect(safety.status).toBe('unsafe');
    expect(safety.reason).toMatch(/cross-host/);

    const finding = redirectFinding('https://a.example/docs', c);
    const proposal = proposeRedirectRewrite(finding, 'See https://a.example/docs for more.\n', TARGET);
    expect(proposal).not.toBeNull();
    expect(proposal!.safe_to_auto_apply).toBe(false);
    expect(proposal!.category).toBe('redirect-rewrite');
  });

  it('a chain mixing a 302 with a 301 is proposed but unsafe (not every hop is permanent)', () => {
    const c = chain(200, 'https://a.example/final', [{ status: 302 }, { status: 301 }, { status: 200 }]);
    const safety = classifyRedirectSafety('https://a.example/start', c);
    expect(safety.status).toBe('unsafe');
  });

  it('a permanent redirect landing on "/" (final path root) is unsafe', () => {
    const c = chain(200, 'https://a.example/', [{ status: 301 }, { status: 200 }]);
    const safety = classifyRedirectSafety('https://a.example/docs', c);
    expect(safety.status).toBe('unsafe');
  });

  it('a permanent redirect landing on a login page is unsafe', () => {
    const c = chain(200, 'https://a.example/login', [{ status: 301 }, { status: 200 }]);
    const safety = classifyRedirectSafety('https://a.example/docs', c);
    expect(safety.status).toBe('unsafe');
  });

  it('a chain that never resolved cleanly (broken / too-many-hops) is flag-only, never proposed', () => {
    const broken: ChainResult = { kind: 'chain', hops: [{ url: 'https://a.example/0', status: 301, location: null }], finalUrl: 'https://a.example/1', finalStatus: null, error: 'too-many-hops' };
    const safety = classifyRedirectSafety('https://a.example/docs', broken);
    expect(safety.status).toBe('flag');
  });

  it('a safe redirect-rewrite proposal carries a real diff and safe_to_auto_apply:true', () => {
    const c = chain(200, 'https://a.example/new-docs', [{ status: 301 }, { status: 200 }]);
    const finding = redirectFinding('https://a.example/old-docs', c);
    const raw = 'intro\nSee https://a.example/old-docs for more.\noutro\n';
    const proposal = proposeRedirectRewrite(finding, raw, TARGET);
    expect(proposal).not.toBeNull();
    expect(proposal!.safe_to_auto_apply).toBe(true);
    expect(proposal!.diff).toContain('-See https://a.example/old-docs for more.');
    expect(proposal!.diff).toContain('+See https://a.example/new-docs for more.');
  });
});

describe('pin policy: pin-bump proposal safety', () => {
  function pinFinding(category: 'stale-pin' | 'version-drift', name: string, pin: string, latest: string, deprecated = false): Finding {
    return { id: 'f2', pageId: 'p1', checkId: 'D-pin', category, line: 2, excerpt: `npm install ${name}@${pin}`, detail: 'drift', counted: true, evidence: { ecosystem: 'npm', name, pin, latest, deprecated } };
  }

  it('same-major (stale-pin) is safe to auto-apply', () => {
    const finding = pinFinding('stale-pin', 'acme', '1.2.0', '1.9.0');
    const raw = 'npm install acme@1.2.0\n';
    const proposal = proposePinBump(finding, raw, TARGET);
    expect(proposal).not.toBeNull();
    expect(proposal!.safe_to_auto_apply).toBe(true);
    expect(proposal!.diff).toContain('+npm install acme@1.9.0');
  });

  it('major-behind (version-drift) is proposed but not safe to auto-apply', () => {
    const finding = pinFinding('version-drift', 'acme', '1.0.0', '3.0.0');
    const raw = 'npm install acme@1.0.0\n';
    const proposal = proposePinBump(finding, raw, TARGET);
    expect(proposal).not.toBeNull();
    expect(proposal!.safe_to_auto_apply).toBe(false);
  });

  it('a deprecated registry latest is never proposed (flag only)', () => {
    const finding = pinFinding('stale-pin', 'acme', '1.2.0', '1.9.0', true);
    const raw = 'npm install acme@1.2.0\n';
    const proposal = proposePinBump(finding, raw, TARGET);
    expect(proposal).toBeNull();
  });

  it('the deprecated-latest-only finding (no pin/latest pair) is never proposed', () => {
    const finding: Finding = { id: 'f3', pageId: 'p1', checkId: 'D-pin', category: 'version-drift', line: 4, excerpt: 'npm install acme@2.0.0', detail: 'deprecated', counted: true, evidence: { ecosystem: 'npm', name: 'acme', latest: '2.0.0', deprecated: true } };
    const proposal = proposePinBump(finding, 'npm install acme@2.0.0\n', TARGET);
    expect(proposal).toBeNull();
  });
});

describe('path-rewrite proposal safety', () => {
  function relPathFinding(target: string, candidates: string[]): Finding {
    return { id: 'f4', pageId: 'p1', checkId: 'D-rel-path', category: 'broken-relative-path', line: 5, excerpt: `See [x](${target}) for more.`, detail: 'broken path', counted: true, evidence: { target, resolved: 'docs/missing.md', candidates } };
  }

  it('exactly one candidate is safe and produces a diff', () => {
    const finding = relPathFinding('docs/missing.md', ['guides/missing.md']);
    const raw = 'See [x](docs/missing.md) for more.\n';
    const proposal = proposePathRewrite(finding, raw, TARGET);
    expect(proposal).not.toBeNull();
    expect(proposal!.safe_to_auto_apply).toBe(true);
    expect(proposal!.diff).toContain('+See [x](guides/missing.md) for more.');
  });

  it('zero candidates is flag only (no proposal)', () => {
    const finding = relPathFinding('docs/missing.md', []);
    const proposal = proposePathRewrite(finding, 'See [x](docs/missing.md) for more.\n', TARGET);
    expect(proposal).toBeNull();
  });

  it('two or more candidates (ambiguous) is flag only (no proposal)', () => {
    const finding = relPathFinding('docs/missing.md', ['guides/missing.md', 'archive/missing.md']);
    const proposal = proposePathRewrite(finding, 'See [x](docs/missing.md) for more.\n', TARGET);
    expect(proposal).toBeNull();
  });
});
