import { describe, it, expect } from 'vitest';
import { buildCandidates, candidateId, type SeedFile, type SeedItem } from '../src/seed';
import { anchors, toRawGithub } from '../src/snapshot';

const item = (full_name: string, stars: number, extra: Partial<SeedItem> = {}): SeedItem => ({
  full_name,
  owner: full_name.split('/')[0]!,
  name: full_name.split('/')[1]!,
  stars,
  html_url: `https://github.com/${full_name}`,
  homepage: null,
  archived: false,
  fork: false,
  topics: [],
  default_branch: 'main',
  language: 'Python',
  pushed_at: null,
  ...extra,
});

const seedFile = (query: string, items: SeedItem[]): SeedFile => ({ query, url: 'u', fetchedAt: 't', status: 200, total_count: items.length, sha256Raw: 'x', items });

describe('candidate list (mechanical, from committed seed files only)', () => {
  it('unions queries, orders by stars desc then name, applies the frozen exclusions, one repo per owner', () => {
    const seeds = [
      seedFile('topic:llm', [item('org-a/big', 1000), item('org-b/mid', 500), item('org-a/small', 400), item('someone/awesome-llm', 900), item('x/archived-thing', 800, { archived: true })]),
      seedFile('topic:rag', [item('org-b/mid', 500), item('org-c/tie', 500), item('forker/copy', 700, { fork: true }), item('org-d/listy', 600, { topics: ['awesome-list'] })]),
    ];
    const { candidates, exclusions } = buildCandidates(seeds, '2026-09-11T00:00:00Z');
    expect(candidates.map((c) => `${c.rank}:${c.full_name}`)).toEqual(['1:org-a/big', '2:org-b/mid', '3:org-c/tie']);
    expect(candidates[1]!.queries).toEqual(['topic:llm', 'topic:rag']);
    expect(exclusions.map((e) => `${e.full_name}=${e.reason}`).sort()).toEqual(
      ['forker/copy=fork', 'org-a/small=duplicate-owner', 'org-d/listy=awesome-list', 'someone/awesome-llm=awesome-list', 'x/archived-thing=archived'].sort(),
    );
  });
  it('is deterministic and ids are stable hashes of full_name', () => {
    const seeds = [seedFile('q', [item('b/b', 1), item('a/a', 1)])];
    const a = buildCandidates(seeds, 't');
    const b = buildCandidates(seeds, 't');
    expect(a.candidates.map((c) => c.full_name)).toEqual(['a/a', 'b/b']);
    expect(a.candidates[0]!.id).toBe(b.candidates[0]!.id);
    expect(candidateId('a/a')).toMatch(/^q_[0-9a-f]{10}$/);
  });
});

describe('snapshot helpers', () => {
  it('lists anchors with visible text and resolved hrefs', () => {
    const html = '<nav><a href="/docs/quickstart"><span>Quick</span> Start</a><a href="https://x.example/gs">Getting started</a><a href="#top">Top</a></nav>';
    expect(anchors(html, 'https://docs.example/home')).toEqual([
      { text: 'Quick Start', href: 'https://docs.example/docs/quickstart' },
      { text: 'Getting started', href: 'https://x.example/gs' },
    ]);
  });
  it('maps GitHub edit/blob links to raw content URLs', () => {
    expect(toRawGithub('https://github.com/o/r/edit/main/docs/a.md')).toBe('https://raw.githubusercontent.com/o/r/main/docs/a.md');
    expect(toRawGithub('https://github.com/o/r/blob/v1.2/README.mdx')).toBe('https://raw.githubusercontent.com/o/r/v1.2/README.mdx');
    expect(toRawGithub('https://example.com/edit/x')).toBeNull();
  });
});
