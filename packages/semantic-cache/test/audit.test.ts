import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protocolFrozenAudit, piiSweep, readmeHeadlineAudit, embeddingAuditCompare } from '../src/audit';
import { loadProtocol, PROTOCOL_DIR } from '../src/protocol';

const protocol = loadProtocol(PROTOCOL_DIR);

describe('protocolFrozenAudit', () => {
  it('passes trivially when nothing has been embedded yet', () => {
    const res = protocolFrozenAudit(protocol, null);
    expect(res.ok).toBe(true);
  });

  it('passes trivially when the embeddings file predates protocolHash/embeddedAt', () => {
    const res = protocolFrozenAudit(protocol, { protocolHash: null, embeddedAt: null });
    expect(res.ok).toBe(true);
  });

  it('passes when the hash matches and frozen_on precedes embeddedAt', () => {
    const res = protocolFrozenAudit(protocol, { protocolHash: protocol.hash, embeddedAt: '2026-09-16T00:00:00.000Z' });
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it('fails when the committed protocol hash differs from what embedding recorded', () => {
    const res = protocolFrozenAudit(protocol, { protocolHash: 'deadbeef', embeddedAt: '2026-09-16T00:00:00.000Z' });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/protocolHash/);
  });

  it('fails when the protocol was frozen after the data it governs was already embedded', () => {
    // frozen_on in the committed protocol is 2026-09-15; embed one second before midnight that day.
    const res = protocolFrozenAudit(protocol, { protocolHash: protocol.hash, embeddedAt: '2026-09-14T23:59:59.000Z' });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/frozen_on/);
  });
});

describe('piiSweep', () => {
  it('finds zero violations across the real committed protocol/ directory', () => {
    const res = piiSweep([PROTOCOL_DIR]);
    expect(res.filesScanned).toBeGreaterThan(0);
    expect(res.violations).toEqual([]);
  });

  it('flags a PII shape (email) in a committed JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-pii-'));
    writeFileSync(join(dir, 'leak.json'), JSON.stringify({ contact: 'someone@example.com' }));
    const res = piiSweep([dir], dir);
    expect(res.filesScanned).toBe(1);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]!.kind).toBe('email');
  });

  it('recurses into subdirectories and skips non-json files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semcache-pii-tree-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'clean.json'), JSON.stringify({ a: 1 }));
    writeFileSync(join(dir, 'notes.txt'), 'someone@example.com');
    const res = piiSweep([dir], dir);
    expect(res.filesScanned).toBe(1);
    expect(res.violations).toEqual([]);
  });
});

describe('readmeHeadlineAudit', () => {
  it('passes trivially when README.md does not exist yet', () => {
    const res = readmeHeadlineAudit(null, 'some headline.');
    expect(res.ok).toBe(true);
  });

  it('passes trivially when there is no run-meta.json headline yet', () => {
    const res = readmeHeadlineAudit('# semcache\n\nSome prose.', null);
    expect(res.ok).toBe(true);
  });

  it('fails when the README does not contain the exact rendered headline', () => {
    const res = readmeHeadlineAudit('# semcache\n\nA cache thing.', 'On 280 hand-written queries...');
    expect(res.ok).toBe(false);
  });

  it('passes when the README contains the exact rendered headline byte for byte', () => {
    const headline = 'On 280 hand-written queries (40 intents...), the cache served 200 of 200 (100%).';
    const res = readmeHeadlineAudit(`# semcache\n\n${headline}\n\nMore prose.`, headline);
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
  });
});

describe('embeddingAuditCompare', () => {
  it('passes when committed and fresh vectors are identical', () => {
    const v = new Float32Array([1, 0, 0]);
    const res = embeddingAuditCompare([{ id: 'a', committed: v, fresh: v }]);
    expect(res.ok).toBe(true);
    expect(res.minCosine).toBeCloseTo(1, 6);
    expect(res.sampled).toBe(1);
  });

  it('fails when a fresh vector diverges from the committed one', () => {
    const res = embeddingAuditCompare([
      { id: 'a', committed: new Float32Array([1, 0, 0]), fresh: new Float32Array([1, 0, 0]) },
      { id: 'b', committed: new Float32Array([1, 0, 0]), fresh: new Float32Array([0, 1, 0]) },
    ]);
    expect(res.ok).toBe(false);
    expect(res.reasons).toHaveLength(1);
    expect(res.reasons[0]).toMatch(/^b:/);
  });

  it('passes trivially with no samples', () => {
    const res = embeddingAuditCompare([]);
    expect(res.ok).toBe(true);
    expect(res.sampled).toBe(0);
  });
});
