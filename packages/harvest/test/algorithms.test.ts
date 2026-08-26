import { describe, it, expect } from 'vitest';
import { planSlices } from '../src/codeSearch';
import { outboundRepoLinks, selectRegistries, type RegistryCandidate } from '../src/registries';
import { parseMarketplaceRepos } from '../src/marketplace';

describe('code-search bisection (planSlices)', () => {
  it('bisects saturated ranges and flags a still-saturated minimum-width leaf', () => {
    // any range starting at 0 stays dense (2000) → bisection drives it to a min-width
    // leaf that is still saturated; every other narrow range resolves.
    const totalFor = (lo: number, hi: number): number => (lo === 0 ? 2000 : hi - lo <= 1 ? 300 : 5000);
    const slices = planSlices(totalFor, 64, 1);
    // full coverage, ascending, no gaps
    expect(slices[0]!.lo).toBe(0);
    expect(slices[slices.length - 1]!.hi).toBe(64);
    for (let i = 1; i < slices.length; i++) expect(slices[i]!.lo).toBe(slices[i - 1]!.hi + 1);
    // the unsplittable dense leaf is marked truncated
    const truncated = slices.filter((s) => s.truncated);
    expect(truncated.length).toBeGreaterThanOrEqual(1);
    expect(truncated.every((s) => s.hi - s.lo <= 1)).toBe(true);
  });

  it('returns a single slice when nothing saturates', () => {
    const slices = planSlices(() => 50, 384, 1);
    expect(slices).toEqual([{ lo: 0, hi: 384, total: 50, truncated: false }]);
  });
});

describe('registry selection', () => {
  it('counts distinct outbound repo links, excluding self', () => {
    const readme = `
      - [alpha](https://github.com/foo/alpha)
      - [beta](https://github.com/bar/beta)
      - [alpha again](https://github.com/foo/alpha)
      - self: https://github.com/me/registry
    `;
    expect(outboundRepoLinks(readme, 'me/registry')).toBe(2);
  });

  it('keeps only registries and ranks by stars', () => {
    const cands: RegistryCandidate[] = [
      { full_name: 'a/reg', stars: 100, description: null, outboundLinks: 50, isRegistry: true },
      { full_name: 'b/tool', stars: 999, description: null, outboundLinks: 2, isRegistry: false },
      { full_name: 'c/reg', stars: 300, description: null, outboundLinks: 30, isRegistry: true },
      { full_name: 'd/reg', stars: 50, description: null, outboundLinks: 25, isRegistry: true },
    ];
    const sel = selectRegistries(cands, 2);
    expect(sel.selected).toEqual(['c/reg', 'a/reg']); // by stars desc, tool excluded
  });
});

describe('marketplace parsing', () => {
  it('extracts owner/repo refs from varied plugin shapes', () => {
    const json = {
      plugins: [
        { name: 'p1', source: 'owner/repo-one' },
        { name: 'p2', repo: 'https://github.com/owner/repo-two' },
        { name: 'p3', source: { repo: 'owner/repo-three' } },
        'owner/repo-four',
      ],
    };
    expect(parseMarketplaceRepos(json)).toEqual([
      'owner/repo-four',
      'owner/repo-one',
      'owner/repo-three',
      'owner/repo-two',
    ]);
  });

  it('returns [] for a shapeless blob', () => {
    expect(parseMarketplaceRepos({ nope: 1 })).toEqual([]);
  });
});
