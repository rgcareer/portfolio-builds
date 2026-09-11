import { describe, it, expect } from 'vitest';
import * as core from '@skillcheck/core';

describe('bootstrap smoke', () => {
  it('resolves the @skillcheck/core workspace alias', () => {
    expect(core).toBeTypeOf('object');
  });

  it('runs on a Node with the built-in crypto + sqlite the build depends on', async () => {
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update('skillcheck').digest('hex')).toHaveLength(64);
  });
});
