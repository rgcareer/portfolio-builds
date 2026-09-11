// GitHub API client for harvest. Uses a token from GITHUB_TOKEN/GH_TOKEN when present
// (required for code + repo search and for a workable rate limit); falls back to
// unauthenticated for the first-party sources (anthropics/skills, official marketplace).
// api.github.com is a fixed trusted host, so this uses fetch directly — safeFetch is
// reserved for attacker-influenced URLs harvested FROM content (registry links, redirects).
//
// fetch and sleep are injectable so tests drive rate-limit / retry / pagination without
// real network or real waiting.

const API = 'https://api.github.com';
const UA = 'skillcheck-harvest';

export class RateLimitError extends Error {
  constructor(
    message: string,
    public resetEpoch: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export interface GitHubClientOptions {
  token?: string | undefined;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Max seconds to wait for a rate-limit reset before throwing (default 900). */
  maxWaitSeconds?: number;
}

export interface GitHubResponse {
  status: number;
  headers: Headers;
  text: string;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GitHubClient {
  private readonly token: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  authenticated: boolean;

  constructor(opts: GitHubClientOptions = {}) {
    this.token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleepImpl ?? realSleep;
    this.maxWaitMs = (opts.maxWaitSeconds ?? 900) * 1000;
    this.authenticated = Boolean(this.token);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  /** Low-level request with rate-limit handling and one transient retry. */
  async request(
    path: string,
    init: RequestInit = {},
    retries = 1,
  ): Promise<GitHubResponse> {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    let res: Response;
    try {
      res = await this.doFetch(url, {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (e) {
      if (retries > 0) {
        await this.sleep(1000);
        return this.request(path, init, retries - 1);
      }
      throw e;
    }

    // Primary/secondary rate limit → wait to reset (bounded) then retry once.
    const remaining = res.headers.get('x-ratelimit-remaining');
    if ((res.status === 403 || res.status === 429) && remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0');
      const waitMs = Math.max(0, reset * 1000 - epochNowMsFromHeader(res));
      if (waitMs > this.maxWaitMs) {
        throw new RateLimitError(`Rate limited; reset in ${Math.round(waitMs / 1000)}s exceeds cap`, reset);
      }
      await this.sleep(waitMs + 500);
      return this.request(path, init, retries);
    }

    if (res.status >= 500 && retries > 0) {
      await this.sleep(1000);
      return this.request(path, init, retries - 1);
    }

    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  async getJson<T>(path: string): Promise<{ status: number; data: T | null; headers: Headers }> {
    const res = await this.request(path);
    let data: T | null = null;
    if (res.status >= 200 && res.status < 300 && res.text) {
      data = JSON.parse(res.text) as T;
    }
    return { status: res.status, data, headers: res.headers };
  }

  /** Recursive git tree for a repo at a ref. Returns blob paths only. */
  async listTree(repo: string, ref = 'HEAD'): Promise<{ paths: string[]; truncated: boolean; sha: string | null }> {
    const { status, data } = await this.getJson<{
      sha: string;
      truncated: boolean;
      tree: { path: string; type: string }[];
    }>(`/repos/${repo}/git/trees/${ref}?recursive=1`);
    if (status !== 200 || !data) return { paths: [], truncated: false, sha: null };
    return {
      paths: data.tree.filter((t) => t.type === 'blob').map((t) => t.path),
      truncated: Boolean(data.truncated),
      sha: data.sha ?? null,
    };
  }

  async getRepoMeta(repo: string): Promise<RepoMeta | null> {
    const { status, data } = await this.getJson<RawRepo>(`/repos/${repo}`);
    if (status !== 200 || !data) return null;
    return normalizeRepo(data);
  }

  /** Fetch a repo tarball (gzip) as a Buffer at a ref. Times out (attacker-influenced host);
   * the decompression bomb is bounded downstream by extractTarballGz's maxOutputLength. */
  async getTarball(repo: string, ref: string, timeoutMs = 30_000): Promise<Buffer | null> {
    const url = `${API}/repos/${repo}/tarball/${ref}`;
    const res = await this.doFetch(url, {
      headers: this.headers({ Accept: 'application/vnd.github+json' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  /** GitHub code search. Requires auth. Returns items + approximate total_count. */
  async searchCode(
    q: string,
    page = 1,
    perPage = 100,
  ): Promise<{ total: number; items: { repo: string; path: string }[]; incompleteResults: boolean }> {
    const { status, data } = await this.getJson<{
      total_count: number;
      incomplete_results: boolean;
      items: { path: string; repository: { full_name: string } }[];
    }>(`/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`);
    if (status !== 200 || !data) return { total: 0, items: [], incompleteResults: status !== 200 };
    return {
      total: data.total_count,
      incompleteResults: data.incomplete_results,
      items: data.items.map((i) => ({ repo: i.repository.full_name, path: i.path })),
    };
  }

  async searchRepos(
    q: string,
    perPage = 50,
  ): Promise<{ full_name: string; stars: number; description: string | null }[]> {
    const { status, data } = await this.getJson<{
      items: { full_name: string; stargazers_count: number; description: string | null }[];
    }>(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`);
    if (status !== 200 || !data) return [];
    return data.items.map((i) => ({ full_name: i.full_name, stars: i.stargazers_count, description: i.description }));
  }
}

function epochNowMsFromHeader(res: Response): number {
  // Prefer the server Date header so wait math doesn't depend on a local clock skew.
  const date = res.headers.get('date');
  const parsed = date ? Date.parse(date) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export interface RepoMeta {
  full_name: string;
  stars: number;
  pushed_at: string | null;
  archived: boolean;
  fork: boolean;
  license: string | null;
  default_branch: string | null;
}

interface RawRepo {
  full_name: string;
  stargazers_count: number;
  pushed_at: string | null;
  archived: boolean;
  fork: boolean;
  license: { spdx_id: string | null } | null;
  default_branch: string | null;
}

export function normalizeRepo(r: RawRepo): RepoMeta {
  return {
    full_name: r.full_name,
    stars: r.stargazers_count ?? 0,
    pushed_at: r.pushed_at ?? null,
    archived: Boolean(r.archived),
    fork: Boolean(r.fork),
    license: r.license?.spdx_id ?? null,
    default_branch: r.default_branch ?? null,
  };
}
