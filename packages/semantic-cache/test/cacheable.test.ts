import { describe, it, expect } from 'vitest';
import { isCacheable, type CacheableSpec } from '../src/cacheable';
import { loadProtocol } from '../src/protocol';

const rules = loadProtocol().cacheRules;

const base = (): CacheableSpec => ({ system: 'You are a helpful assistant.', user: 'What is the status of order #4471?' });

describe('isCacheable', () => {
  it('refuses a spec with tools', () => {
    const { cacheable, reason } = isCacheable({ ...base(), tools: [{ name: 'lookup' }] }, rules);
    expect(cacheable).toBe(false);
    expect(reason).toBe('tools');
  });

  it('refuses a streaming spec', () => {
    const { cacheable, reason } = isCacheable({ ...base(), stream: true }, rules);
    expect(cacheable).toBe(false);
    expect(reason).toBe('stream');
  });

  it('refuses a spec explicitly flagged time-sensitive', () => {
    const { cacheable, reason } = isCacheable({ ...base(), timeSensitive: true }, rules);
    expect(cacheable).toBe(false);
    expect(reason).toBe('timeSensitive');
  });

  it('refuses a spec explicitly opted out with noCache', () => {
    const { cacheable, reason } = isCacheable({ ...base(), noCache: true }, rules);
    expect(cacheable).toBe(false);
    expect(reason).toBe('noCache');
  });

  it('refuses when the user text matches the time-sensitivity regex', () => {
    const { cacheable, reason } = isCacheable({ ...base(), user: 'What is the weather today?' }, rules);
    expect(cacheable).toBe(false);
    expect(reason).toBe('time-sensitive-text');
  });

  it('refuses when the user text contains PII', () => {
    const { cacheable, reason } = isCacheable({ ...base(), user: 'Please email me at jane.doe@example.com' }, rules);
    expect(cacheable).toBe(false);
    expect(reason).toBe('pii');
  });

  it('refuses an empty user message', () => {
    const { cacheable, reason } = isCacheable({ ...base(), user: '   ' }, rules);
    expect(cacheable).toBe(false);
    expect(reason).toBe('empty-user');
  });

  it('accepts a plain, cacheable spec', () => {
    const { cacheable, reason } = isCacheable(base(), rules);
    expect(cacheable).toBe(true);
    expect(reason).toBe('ok');
  });
});
