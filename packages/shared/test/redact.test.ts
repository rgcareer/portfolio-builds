import { describe, it, expect } from 'vitest';
import { hmacToken, makeTokenizer, requireSalt } from '../src/redact';
import { findPii, assertNoPii, redactIdentifiers, redactDeep } from '../src/pii';

describe('identifier redaction for generated files', () => {
  it('replaces personal profile URLs and emails with fixed tokens, leaves org pages, is idempotent', () => {
    const s = 'hp https://linkedin.com/in/someone | org https://www.linkedin.com/company/acme | mail a.b@c.io | url https://njump.me/x@y.org';
    const r = redactIdentifiers(s);
    expect(r).toBe('hp [redacted:profile-url] | org https://www.linkedin.com/company/acme | mail [redacted:email] | url https://njump.me/[redacted:email]');
    expect(redactIdentifiers(r)).toBe(r);
    expect(findPii(r, ['email', 'linkedin'])).toEqual([]);
  });
  it('redactDeep walks arrays and objects without changing shape', () => {
    const v = { links: ['https://x.example', 'https://linkedin.com/in/p'], n: 3, nested: { e: 'me@x.io' } };
    expect(redactDeep(v)).toEqual({ links: ['https://x.example', '[redacted:profile-url]'], n: 3, nested: { e: '[redacted:email]' } });
  });
});

describe('HMAC redaction', () => {
  const salt = 'a-test-salt-of-sufficient-length';
  it('is deterministic for one salt and different across salts', () => {
    expect(hmacToken(salt, 'Acme Corp', 'co_')).toBe(hmacToken(salt, 'Acme Corp', 'co_'));
    expect(hmacToken(salt, 'Acme Corp', 'co_')).not.toBe(hmacToken(salt + 'x', 'Acme Corp', 'co_'));
    expect(hmacToken(salt, 'Acme Corp', 'co_')).toMatch(/^co_[0-9a-f]{8}$/);
  });
  it('tokenizer memoizes and never leaks the input', () => {
    const t = makeTokenizer(salt, 'id_', 10);
    const a = t('secret-value');
    expect(t('secret-value')).toBe(a);
    expect(a).not.toContain('secret');
    expect(a).toHaveLength(13);
  });
  it('requireSalt refuses unset or short salts (no default salt exists)', () => {
    expect(() => requireSalt({})).toThrow(/PB_ANON_SALT/);
    expect(() => requireSalt({ PB_ANON_SALT: 'short' })).toThrow();
    expect(requireSalt({ PB_ANON_SALT: salt })).toBe(salt);
  });
});

describe('PII sweep', () => {
  it('finds emails, phones, uuids, linkedin slugs, and key shapes', () => {
    const text = [
      'contact jane.doe@example.com or (555) 123-4567',
      'id 123e4567-e89b-12d3-a456-426614174000',
      'https://www.linkedin.com/in/jane-doe-123',
      'key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'aws AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const kinds = findPii(text).map((h) => h.kind);
    expect(kinds).toEqual(expect.arrayContaining(['email', 'phone', 'uuid', 'linkedin', 'anthropic-key', 'github-token', 'aws-key']));
  });
  it('is quiet on a clean snapshot line and on anonymized tokens', () => {
    expect(findPii('run 2026-09-10 co_1a2b3c4d status=failed jobs_found=12 http 404')).toEqual([]);
    expect(() => assertNoPii('co_1a2b3c4d id_ffeeddccaa', 'snapshot')).not.toThrow();
  });
  it('assertNoPii names the label and hit kinds', () => {
    expect(() => assertNoPii('mail me: a@b.co', 'corpus/x/text.txt')).toThrow(/corpus\/x\/text.txt.*email/);
  });
});
