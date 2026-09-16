import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPolicy, PROTOCOL_DIR, DATA_DIR, PKG_ROOT } from '../src/protocol';

describe('protocol: loadPolicy', () => {
  it('loads both protocol files and exposes rules + prices', () => {
    const p = loadPolicy();
    expect(p.prices.models['claude-opus-4-8']).toBeDefined();
    expect(p.rules.version).toBe(1);
    expect(p.rules.window.from).toBe('2026-08-16');
    expect(p.rules.window.to).toBe('2026-09-15');
  });

  it('hash covers both files: changing either file changes the hash', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'lca-protocol-'));
    try {
      const pricesSrc = readFileSync(resolve(PROTOCOL_DIR, 'prices.json'), 'utf8');
      const policySrc = readFileSync(resolve(PROTOCOL_DIR, 'policy.json'), 'utf8');
      writeFileSync(resolve(tmp, 'prices.json'), pricesSrc);
      writeFileSync(resolve(tmp, 'policy.json'), policySrc);
      const base = loadPolicy(tmp);
      expect(base.hash).toBe(loadPolicy().hash);

      // Mutate prices.json only -> hash changes
      writeFileSync(resolve(tmp, 'prices.json'), pricesSrc.replace('"in": 5', '"in": 6'));
      const withPricesChanged = loadPolicy(tmp);
      expect(withPricesChanged.hash).not.toBe(base.hash);

      // Restore prices, mutate policy.json only -> hash changes (and differs from the prices-mutated one)
      writeFileSync(resolve(tmp, 'prices.json'), pricesSrc);
      writeFileSync(resolve(tmp, 'policy.json'), policySrc.replace('"version": 1', '"version": 2'));
      const withPolicyChanged = loadPolicy(tmp);
      expect(withPolicyChanged.hash).not.toBe(base.hash);
      expect(withPolicyChanged.hash).not.toBe(withPricesChanged.hash);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exposes stable PKG_ROOT / PROTOCOL_DIR / DATA_DIR helpers', () => {
    expect(PKG_ROOT.endsWith('llm-cost-autopilot')).toBe(true);
    expect(PROTOCOL_DIR).toBe(resolve(PKG_ROOT, 'protocol'));
    expect(DATA_DIR).toBe(resolve(PKG_ROOT, 'data'));
  });
});
