import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scrubSecrets, scrubChain, HopAwareLookup, type ChainResult } from '../src/lookup';

// Credential-*shaped* samples, composed at runtime so no contiguous secret-shaped literal is
// ever committed (not even this canonical AWS documentation example key), while the scrub
// functions still see the real shapes at test time.
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'; // AKIA + 16 chars
const ANTHROPIC_KEY = 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123';
const SIG_HEX = 'abcdef0123456789abcdef0123456789abcdef01'; // 40 hex chars

describe('scrubSecrets', () => {
  it('masks an AWS access-key id (AKIA + 16)', () => {
    expect(scrubSecrets(`id=${AWS_KEY}`)).toBe('id=<redacted:aws-key>');
    expect(scrubSecrets(`id=${AWS_KEY}`)).not.toContain(AWS_KEY);
  });

  it('masks an Anthropic key (sk-ant-...) distinctly from a generic openai key', () => {
    expect(scrubSecrets(ANTHROPIC_KEY)).toBe('<redacted:anthropic-key>');
    expect(scrubSecrets(`sk-${'a'.repeat(40)}`)).toBe('<redacted:openai-key>');
  });

  it('masks GitHub tokens (ghp/gho/ghu/ghs/ghr_...)', () => {
    for (const p of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      const tok = `${p}_0123456789abcdefghijABCD`;
      expect(scrubSecrets(`token ${tok} end`)).toBe('token <redacted:github-token> end');
    }
  });

  it('masks the VALUES of sensitive URL query params, keeping the rest of the URL intact', () => {
    const url =
      `https://asset.example/o.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
      `&X-Amz-Credential=${AWS_KEY}%2F20260101%2Fus-east-1%2Fs3%2Faws4_request` +
      `&X-Amz-Signature=${SIG_HEX}` +
      `&X-Amz-SignedHeaders=host`;
    const out = scrubSecrets(url);
    expect(out).not.toContain(AWS_KEY);
    expect(out).toContain('X-Amz-Credential=<redacted:X-Amz-Credential>');
    expect(out).toContain('X-Amz-Signature=<redacted:X-Amz-Signature>');
    // Non-sensitive params are preserved verbatim.
    expect(out).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(out).toContain('X-Amz-SignedHeaders=host');
  });

  it('masks other sensitive param names (access_token, api_key, token) without over-matching', () => {
    expect(scrubSecrets('https://h/x?access_token=abc123&keep=1')).toBe('https://h/x?access_token=<redacted:access_token>&keep=1');
    expect(scrubSecrets('https://h/x?api_key=zzz')).toBe('https://h/x?api_key=<redacted:api_key>');
    expect(scrubSecrets('https://h/x?token=t0p&x=2')).toBe('https://h/x?token=<redacted:token>&x=2');
  });

  it('masks non-AWS signed-URL params and extra key shapes (Azure/GCS/CloudFront, ASIA/AIza/Slack/GitLab)', () => {
    // Azure SAS (a GitHub release asset 302s to an Azure blob host with sig=…) + a signed JWT bearer.
    expect(scrubSecrets('https://h/o.mp4?skoid=x&sig=abc%2Fdef%2Bghi123&se=2026')).toBe(
      'https://h/o.mp4?skoid=x&sig=<redacted:sig>&se=2026',
    );
    expect(scrubSecrets('https://h/a?jwt=eyJhbGciOi.payload.signature&k=1')).toBe('https://h/a?jwt=<redacted:jwt>&k=1');
    // Google Cloud Storage signed URLs.
    expect(scrubSecrets('https://h/o?X-Goog-Credential=svc%40p.iam&X-Goog-Signature=deadbeef')).toBe(
      'https://h/o?X-Goog-Credential=<redacted:X-Goog-Credential>&X-Goog-Signature=<redacted:X-Goog-Signature>',
    );
    expect(scrubSecrets('https://h/o?GoogleAccessId=svc@p&x=1')).toBe('https://h/o?GoogleAccessId=<redacted:GoogleAccessId>&x=1');
    // CloudFront signed URLs.
    expect(scrubSecrets('https://h/o?Policy=eyJ&Signature=zzz&Key-Pair-Id=APKA123')).toContain('Key-Pair-Id=<redacted:Key-Pair-Id>');
    // Extra bare key shapes.
    expect(scrubSecrets(`ASIA${'A'.repeat(16)}`)).toBe('<redacted:aws-key>');
    expect(scrubSecrets(`AIza${'a'.repeat(35)}`)).toBe('<redacted:google-api-key>');
    expect(scrubSecrets(`xoxb-${'1'.repeat(12)}`)).toBe('<redacted:slack-token>');
    expect(scrubSecrets(`glpat-${'a'.repeat(20)}`)).toBe('<redacted:gitlab-token>');
  });

  it('leaves an ordinary URL (and ordinary text) untouched', () => {
    const ordinary = 'https://docs.example.com/guide/v2/setup?ref=main&page=3#install';
    expect(scrubSecrets(ordinary)).toBe(ordinary);
    expect(scrubSecrets('just some plain text, no secrets here')).toBe('just some plain text, no secrets here');
    expect(scrubSecrets('')).toBe('');
  });

  it('is idempotent (scrubbing an already-scrubbed string is a no-op)', () => {
    const url = `https://a/b?X-Amz-Credential=${AWS_KEY}%2Fx&X-Amz-Signature=${SIG_HEX}`;
    const once = scrubSecrets(url);
    expect(scrubSecrets(once)).toBe(once);
  });
});

describe('scrubChain', () => {
  it('cleans a chain whose finalUrl carries a presigned AWS credential, across hops and finalUrl', () => {
    const presigned = `https://asset.example/o.mp4?X-Amz-Credential=${AWS_KEY}%2Fd%2Fr%2Fs%2Faws4_request&X-Amz-Signature=${SIG_HEX}`;
    const dirty: ChainResult = {
      kind: 'chain',
      hops: [
        { url: 'https://docs.example/asset', status: 302, location: presigned },
        { url: presigned, status: 200, location: null },
      ],
      finalUrl: presigned,
      finalStatus: 200,
      error: null,
    };
    const clean = scrubChain(dirty);
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain(AWS_KEY);
    expect(clean.finalUrl).toContain('X-Amz-Credential=<redacted:X-Amz-Credential>');
    expect(clean.hops[0]!.location).toContain('<redacted:X-Amz-Credential>');
    expect(clean.hops[1]!.url).toContain('<redacted:X-Amz-Signature>');
    // Structure/metadata are preserved — only URL strings change.
    expect(clean.hops).toHaveLength(2);
    expect(clean.hops.map((h) => h.status)).toEqual([302, 200]);
    expect(clean.finalStatus).toBe(200);
    expect(clean.error).toBeNull();
  });

  it('leaves a secret-free chain structurally identical', () => {
    const chain: ChainResult = {
      kind: 'chain',
      hops: [{ url: 'https://a.example/x', status: 200, location: null }],
      finalUrl: 'https://a.example/x',
      finalStatus: 200,
      error: null,
    };
    expect(scrubChain(chain)).toEqual(chain);
  });
});

describe('HopAwareLookup scrubs a secret-bearing cache entry on read', () => {
  const dir = resolve(__dirname, 'fixtures', 'lookup-scrub-tmp');
  const cachePath = resolve(dir, 'cache.json');
  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns a scrubbed chain from the cache-hit (snapshot) path', async () => {
    const link = 'https://docs.example/asset';
    const presigned = `https://asset.example/o.mp4?X-Amz-Credential=${AWS_KEY}%2Fd&X-Amz-Signature=${SIG_HEX}`;
    const seeded = {
      version: 1,
      entries: {
        [`link:${link}`]: {
          fetchedAt: '2026-01-01T00:00:00.000Z',
          value: { kind: 'chain', hops: [{ url: link, status: 302, location: presigned }, { url: presigned, status: 200, location: null }], finalUrl: presigned, finalStatus: 200, error: null },
        },
      },
    };
    writeFileSync(cachePath, JSON.stringify(seeded));
    const lookup = new HopAwareLookup({ cachePath, mode: 'snapshot', userAgent: 'test', timeoutMs: 1000 });
    const chain = await lookup.link(link);
    expect(JSON.stringify(chain)).not.toContain(AWS_KEY);
    expect(chain.finalUrl).toContain('<redacted:X-Amz-Credential>');
    expect(chain.finalStatus).toBe(200);
  });
});
