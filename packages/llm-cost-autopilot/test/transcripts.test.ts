import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { makeTokenizer, assertNoPii } from '@portfolio-builds/shared';
import { extractClaudeCode } from '../src/transcripts';

const ROOT = resolve(__dirname, 'fixtures/claude-projects');
const SALT = 'test-salt-0123456789abcdef';
const WINDOW = { from: '2026-08-16', to: '2026-09-15' };

async function extract() {
  const tokenizer = makeTokenizer(SALT);
  return extractClaudeCode(ROOT, tokenizer, WINDOW);
}

describe('transcripts: extractClaudeCode', () => {
  it('dedupes by message.id on a split-block fixture; final (deduped) call kept exactly once with its usage', async () => {
    const { records } = await extract();
    const msg1 = records.filter((r) => r.id === records.find((x) => x.ts === '2026-08-20T10:15:30.123Z')?.id);
    const byTs = records.filter((r) => r.ts.startsWith('2026-08-20T10:15:30'));
    expect(byTs.length).toBe(1);
    expect(byTs[0]!.usage).toEqual({ input: 100, cacheRead: 10, cacheCreation5m: 5, cacheCreation1h: 0, output: 50 });
  });

  it('drops cwd/gitBranch/uuid/requestId entirely — none of those raw values appear anywhere in the output', async () => {
    const { records } = await extract();
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('req-alpha-778');
    expect(serialized).not.toContain('/Users/alice/secret-project');
    expect(serialized).not.toContain('feature/xyz-branch-9F3K2');
    expect(serialized).not.toContain('22222222-2222-2222-2222-222222222222');
  });

  it('HMAC-tokenizes session and project (tags.project), never the raw id', async () => {
    const { records } = await extract();
    const tokenizer = makeTokenizer(SALT);
    const r = records.find((x) => x.ts.startsWith('2026-08-20T10:15:30'))!;
    expect(r.session).toBe(tokenizer('session-alpha'));
    expect(r.session).not.toBe('session-alpha');
    expect(r.tags.project).toBe(tokenizer('proj-alpha'));
    expect(r.tags.project).not.toBe('proj-alpha');
  });

  it('tallies each exclusion reason', async () => {
    const { tallies } = await extract();
    expect(tallies['no-usage']).toBe(1);
    expect(tallies['synthetic']).toBe(1);
    expect(tallies['alias-model']).toBe(1);
    expect(tallies['banned-model']).toBe(1);
    expect(tallies['unpriced-model']).toBe(1);
  });

  it('window filter is inclusive of both boundary dates and excludes calls outside it', async () => {
    const { records } = await extract();
    const ids = records.map((r) => r.ts);
    expect(ids).toContain('2026-08-16T00:00:00.000Z'); // start boundary kept
    expect(ids).toContain('2026-09-15T23:59:59.999Z'); // end boundary kept
    expect(ids).not.toContain('2026-07-01T00:00:00.000Z'); // before window
    expect(ids).not.toContain('2026-09-16T00:00:00.000Z'); // after window
  });

  it('preserves sidechain', async () => {
    const { records } = await extract();
    const r = records.find((x) => x.ts === '2026-08-22T12:00:00.000Z')!;
    expect(r.sidechain).toBe(true);
    const nonSide = records.find((x) => x.ts === '2026-08-20T10:15:30.123Z')!;
    expect(nonSide.sidechain).toBe(false);
  });

  it('falls back to cacheCreation5m when only the legacy cache_creation_input_tokens field is present', async () => {
    const { records } = await extract();
    const r = records.find((x) => x.ts === '2026-08-23T08:00:00.000Z')!;
    expect(r.usage).toEqual({ input: 8, cacheRead: 0, cacheCreation5m: 40, cacheCreation1h: 0, output: 9 });
  });

  it('walks multiple project directories', async () => {
    const { records } = await extract();
    const r = records.find((x) => x.ts === '2026-08-25T14:00:00.000Z');
    expect(r).toBeDefined();
    expect(r!.model).toBe('claude-sonnet-5');
  });

  it('output passes assertNoPii', async () => {
    const { records } = await extract();
    expect(() => assertNoPii(JSON.stringify(records), 'transcripts-fixture')).not.toThrow();
  });

  it('sets source, provider, latencyTolerant, and drops purpose/runId/tenant to null', async () => {
    const { records } = await extract();
    const r = records.find((x) => x.ts === '2026-08-20T10:15:30.123Z')!;
    expect(r.source).toBe('claude-code');
    expect(r.provider).toBe('anthropic');
    expect(r.latencyTolerant).toBe(false);
    expect(r.purpose).toBeNull();
    expect(r.runId).toBeNull();
    expect(r.tenant).toBeNull();
  });

  it('ignores non-assistant lines and skips malformed JSON lines without throwing', async () => {
    await expect(extract()).resolves.toBeDefined();
  });

  it('returns empty records and zeroed tallies for a root with no project directories', async () => {
    const tokenizer = makeTokenizer(SALT);
    const { records, tallies } = await extractClaudeCode(resolve(__dirname, 'fixtures/does-not-exist'), tokenizer, WINDOW);
    expect(records).toEqual([]);
    expect(Object.values(tallies).every((v) => v === 0)).toBe(true);
  });
});
