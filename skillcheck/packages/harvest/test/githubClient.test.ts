import { describe, it, expect } from 'vitest';
import { GitHubClient } from '../src/githubClient';
import { makeResponse } from './helpers';

function queueClient(responses: Response[], token?: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const client = new GitHubClient({
    token,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return responses[Math.min(i++, responses.length - 1)]!;
    }) as unknown as typeof fetch,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

describe('GitHubClient', () => {
  it('waits for the rate-limit reset and retries', async () => {
    const date = 'Tue, 25 Aug 2026 00:00:00 GMT';
    const resetEpoch = Math.floor(Date.parse(date) / 1000) + 2; // reset 2s after server "now"
    const { client, sleeps } = queueClient([
      makeResponse({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch), date } }),
      makeResponse({ status: 200, body: '{"ok":true}' }),
    ]);
    const res = await client.request('/x');
    expect(res.status).toBe(200);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it('retries once on a 5xx', async () => {
    const { client, calls } = queueClient([
      makeResponse({ status: 502, body: 'bad gateway' }),
      makeResponse({ status: 200, body: 'ok' }),
    ]);
    const res = await client.request('/x');
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it('sends an Authorization header when a token is present', async () => {
    const { client, calls } = queueClient([makeResponse({ status: 200, body: '{}' })], 'secret-token');
    expect(client.authenticated).toBe(true);
    await client.request('/x');
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-token');
  });

  it('parses a recursive tree into blob paths', async () => {
    const tree = {
      sha: 'abc',
      truncated: false,
      tree: [
        { path: 'a/SKILL.md', type: 'blob' },
        { path: 'a', type: 'tree' },
        { path: 'b/SKILL.md', type: 'blob' },
      ],
    };
    const { client } = queueClient([makeResponse({ status: 200, body: JSON.stringify(tree) })]);
    const r = await client.listTree('o/r');
    expect(r.paths).toEqual(['a/SKILL.md', 'b/SKILL.md']);
    expect(r.sha).toBe('abc');
  });

  it('parses code-search results with total_count', async () => {
    const body = JSON.stringify({
      total_count: 2,
      incomplete_results: false,
      items: [
        { path: 'x/SKILL.md', repository: { full_name: 'o/x' } },
        { path: 'y/SKILL.md', repository: { full_name: 'o/y' } },
      ],
    });
    const { client } = queueClient([makeResponse({ status: 200, body })]);
    const r = await client.searchCode('q');
    expect(r.total).toBe(2);
    expect(r.items).toEqual([
      { repo: 'o/x', path: 'x/SKILL.md' },
      { repo: 'o/y', path: 'y/SKILL.md' },
    ]);
  });
});
