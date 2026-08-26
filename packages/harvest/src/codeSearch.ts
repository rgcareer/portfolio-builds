import type { GitHubClient } from './githubClient';

// GitHub code search returns at most 1000 results per query. We partition the query space
// by the file-size qualifier and adaptively bisect any range that saturates. A leaf that
// still saturates at the minimum width is marked `truncated`, and the harvested N is then
// published as ">= N" — never a silent undercount (plan hole H5).

export interface SizeSlice {
  lo: number;
  hi: number;
  total: number;
  truncated: boolean;
}

const SATURATION = 1000;

/**
 * Pure bisection planner. `totalFor(lo, hi)` returns the (approximate) result count for the
 * size range [lo, hi] KB. Returns the leaf ranges to page, in ascending order, with a
 * truncated flag on any minimum-width range that is still saturated.
 */
export function planSlices(
  totalFor: (lo: number, hi: number) => number,
  sizeCap: number,
  minWidth = 1,
): SizeSlice[] {
  const slices: SizeSlice[] = [];
  const stack: [number, number][] = [[0, sizeCap]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    const total = totalFor(lo, hi);
    if (total >= SATURATION && hi - lo > minWidth) {
      const mid = Math.floor((lo + hi) / 2);
      stack.push([mid + 1, hi]);
      stack.push([lo, mid]);
    } else {
      slices.push({ lo, hi, total, truncated: total >= SATURATION });
    }
  }
  slices.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  return slices;
}

export interface CodeSearchResult {
  items: { repo: string; path: string }[];
  slices: SizeSlice[];
  truncated: boolean;
}

/**
 * Enumerate all code-search results for `baseQuery` across size slices, deduping by
 * repo+path. Pages each slice up to the 1000-result ceiling.
 */
export async function codeSearchAll(
  client: GitHubClient,
  baseQuery: string,
  opts: { sizeCap?: number; minWidth?: number; perPage?: number } = {},
): Promise<CodeSearchResult> {
  const sizeCap = opts.sizeCap ?? 384; // code search does not index files > ~384 KB
  const minWidth = opts.minWidth ?? 1;
  const perPage = opts.perPage ?? 100;

  // First pass: discover slice boundaries by querying totals (cached to avoid re-querying).
  const totalCache = new Map<string, number>();
  const totalFor = async (lo: number, hi: number): Promise<number> => {
    const key = `${lo}..${hi}`;
    const cached = totalCache.get(key);
    if (cached !== undefined) return cached;
    const r = await client.searchCode(`${baseQuery} size:${lo}..${hi}`, 1, 1);
    totalCache.set(key, r.total);
    return r.total;
  };

  // Async bisection mirroring planSlices (planSlices is unit-tested with a sync oracle).
  const leaves: SizeSlice[] = [];
  const stack: [number, number][] = [[0, sizeCap]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    const total = await totalFor(lo, hi);
    if (total >= SATURATION && hi - lo > minWidth) {
      const mid = Math.floor((lo + hi) / 2);
      stack.push([mid + 1, hi]);
      stack.push([lo, mid]);
    } else {
      leaves.push({ lo, hi, total, truncated: total >= SATURATION });
    }
  }
  leaves.sort((a, b) => a.lo - b.lo || a.hi - b.hi);

  const seen = new Set<string>();
  const items: { repo: string; path: string }[] = [];
  for (const slice of leaves) {
    const pages = Math.min(Math.ceil(slice.total / perPage), Math.floor(SATURATION / perPage));
    for (let page = 1; page <= pages; page++) {
      const r = await client.searchCode(`${baseQuery} size:${slice.lo}..${slice.hi}`, page, perPage);
      for (const it of r.items) {
        const key = `${it.repo}\n${it.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          items.push(it);
        }
      }
      if (r.items.length < perPage) break;
    }
  }

  return { items, slices: leaves, truncated: leaves.some((s) => s.truncated) };
}
