import { describe, it, expect } from 'vitest';
import { SIMULATED, SIMULATED_CONFIDENCE_CAP } from '@portfolio-builds/shared';
import { runAssertion, parseFirstJsonObject, topLevelJsonObjects } from '../src/assertions';

const expected = {
  id: 'WO-1234',
  date: '2026-03-07',
  total_cents: 5000,
  paid: true,
  status: 'closed',
  items: [{ name: 'Labor', qty: 2, unit_cents: 2500 }],
};
const bare = JSON.stringify(expected);
const fenced = '```json\n' + bare + '\n```';

describe('json-parse', () => {
  it('accepts a bare single object', () => {
    expect(runAssertion({ kind: 'json-parse' }, { content: bare }).pass).toBe(true);
  });
  it('accepts a fenced single object', () => {
    expect(runAssertion({ kind: 'json-parse' }, { content: fenced }).pass).toBe(true);
  });
  it('rejects two objects', () => {
    expect(runAssertion({ kind: 'json-parse' }, { content: bare + '\n' + bare }).pass).toBe(false);
  });
  it('rejects prose-only', () => {
    expect(runAssertion({ kind: 'json-parse' }, { content: 'Here is the answer, no JSON.' }).pass).toBe(false);
  });
  it('topLevelJsonObjects counts balanced parseable objects', () => {
    expect(topLevelJsonObjects(bare)).toHaveLength(1);
    expect(topLevelJsonObjects(bare + bare)).toHaveLength(2);
    expect(topLevelJsonObjects('no json')).toHaveLength(0);
  });
});

describe('json-schema', () => {
  it('passes a well-typed object', () => {
    expect(runAssertion({ kind: 'json-schema' }, { content: bare }).pass).toBe(true);
  });
  it('flags a missing key', () => {
    const { paid, ...missing } = expected;
    void paid;
    expect(runAssertion({ kind: 'json-schema' }, { content: JSON.stringify(missing) }).pass).toBe(false);
  });
  it('flags a wrong type', () => {
    const wrong = { ...expected, total_cents: '5000' };
    expect(runAssertion({ kind: 'json-schema' }, { content: JSON.stringify(wrong) }).pass).toBe(false);
  });
});

describe('exact-json', () => {
  it('passes on canonical equality and ignores key order', () => {
    const reordered = { items: expected.items, status: 'closed', paid: true, total_cents: 5000, date: '2026-03-07', id: 'WO-1234' };
    const r = runAssertion({ kind: 'exact-json', expected }, { content: JSON.stringify(reordered) });
    expect(r.pass).toBe(true);
    expect(r.headlineEligible).toBe(true);
  });
  it('fails when a value differs', () => {
    const diff = { ...expected, total_cents: 5001 };
    expect(runAssertion({ kind: 'exact-json', expected }, { content: JSON.stringify(diff) }).pass).toBe(false);
  });
  it('extracts the first balanced object even with surrounding prose', () => {
    const obj = parseFirstJsonObject('Sure! ' + bare + ' hope that helps');
    expect(obj).toEqual(expected);
  });
});

describe('contains and regex', () => {
  it('contains matches a substring', () => {
    expect(runAssertion({ kind: 'contains', value: 'WO-1234' }, { content: bare }).pass).toBe(true);
    expect(runAssertion({ kind: 'contains', value: 'nope' }, { content: bare }).pass).toBe(false);
  });
  it('regex matches a pattern', () => {
    expect(runAssertion({ kind: 'regex', pattern: 'WO-\\d{4}' }, { content: bare }).pass).toBe(true);
    expect(runAssertion({ kind: 'regex', pattern: '^\\d+$' }, { content: bare }).pass).toBe(false);
  });
});

describe('cost and latency caps', () => {
  it('cost-usd-max passes under and fails over the cap', () => {
    expect(runAssertion({ kind: 'cost-usd-max', maxUsd: 0.01 }, { content: bare, costUsd: 0.005 }).pass).toBe(true);
    expect(runAssertion({ kind: 'cost-usd-max', maxUsd: 0.01 }, { content: bare, costUsd: 0.02 }).pass).toBe(false);
  });
  it('latency-ms-max passes under and fails over the cap', () => {
    expect(runAssertion({ kind: 'latency-ms-max', maxMs: 1000 }, { content: bare, latencyMs: 500 }).pass).toBe(true);
    expect(runAssertion({ kind: 'latency-ms-max', maxMs: 1000 }, { content: bare, latencyMs: 1500 }).pass).toBe(false);
  });
});

describe('rubric', () => {
  it('throws unless allowSimulated is set', () => {
    expect(() => runAssertion({ kind: 'rubric', criterion: 'is polite' }, { content: bare })).toThrow();
  });
  it('returns a [SIMULATED] result capped at 0.80 confidence, never headline-eligible', () => {
    const r = runAssertion({ kind: 'rubric', criterion: 'is polite', allowSimulated: true, score: 0.95, model: 'claude-haiku-4-5' }, { content: bare });
    expect(r.independence).toBe(SIMULATED);
    expect(r.confidence).toBeLessThanOrEqual(SIMULATED_CONFIDENCE_CAP);
    expect(r.confidence).toBe(SIMULATED_CONFIDENCE_CAP);
    expect(r.headlineEligible).toBe(false);
    expect(r.pass).toBe(true);
  });
});
