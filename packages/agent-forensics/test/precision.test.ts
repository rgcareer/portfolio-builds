import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRecord } from '@portfolio-builds/shared';
import { loadProtocol } from '../src/protocol';
import { precisionRecall } from '../src/precision';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELED = resolve(HERE, '../fixtures/labeled');
const protocol = loadProtocol();

const records: RunRecord[] = readdirSync(LABELED)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(resolve(LABELED, f), 'utf8')) as RunRecord);

describe('precision / recall on the labeled fixtures', () => {
  it('loads 40 labeled RunRecords', () => {
    expect(records).toHaveLength(40);
  });

  it('gives precision = recall = 1 for every detector', () => {
    const pr = precisionRecall(records, protocol);
    for (const d of pr.perDetector) {
      expect(d.precision, `${d.detector} precision (fp=${d.fp})`).toBe(1);
      expect(d.recall, `${d.detector} recall (fn=${d.fn})`).toBe(1);
    }
  });

  it('carries the own-specification caveat and covers every detector', () => {
    const pr = precisionRecall(records, protocol);
    expect(pr.note).toMatch(/own specification/);
    expect(pr.perDetector).toHaveLength(11);
  });
});
