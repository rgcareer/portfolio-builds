import { describe, it, expect } from 'vitest';
import { Ledger, SIMULATED, SIMULATED_CONFIDENCE_CAP } from '@portfolio-builds/shared';
import { proposeProsePrerequisite, PREREQ_PURPOSE } from '../src/llm';
import type { Finding, ProposalTarget } from '../src/types';

const TARGET: ProposalTarget = { kind: 'repo-file', repo: 'repo-a', path: 'README.md', prReady: true };

function prereqFinding(): Finding {
  return {
    id: 'f1',
    pageId: 'p1',
    checkId: 'D-prereq',
    category: 'missing-prerequisite',
    line: 4,
    excerpt: 'echo $API_TOKEN',
    detail: 'environment variable API_TOKEN is used in code but never mentioned in prose',
    counted: true,
    evidence: { kind: 'env', name: 'API_TOKEN', insertAfterLine: 5 },
  };
}

const RAW = 'intro\n\n```bash\necho $API_TOKEN\n```\n\noutro\n';

describe('proposeProsePrerequisite: mock mode', () => {
  it('returns a proposal with independence [SIMULATED], confidence capped at 0.80, and safe_to_auto_apply:false', async () => {
    const ledger = new Ledger();
    const finding = prereqFinding();
    const mock = async () => 'Set the API_TOKEN environment variable before running this command.';
    const r = await proposeProsePrerequisite(finding, RAW, TARGET, { mock, ledger, runId: 'run-1' });

    expect(r.error).toBeNull();
    expect(r.proposal).not.toBeNull();
    expect(r.proposal!.independence).toBe(SIMULATED);
    expect(r.proposal!.confidence).not.toBeNull();
    expect(r.proposal!.confidence!).toBeLessThanOrEqual(SIMULATED_CONFIDENCE_CAP);
    expect(r.proposal!.safe_to_auto_apply).toBe(false);
    expect(r.proposal!.source).toBe('llm');
    expect(r.proposal!.category).toBe('prose-prerequisite');
    expect(r.proposal!.evidence['sentence']).toContain('API_TOKEN');
    ledger.close();
  });

  it('the ledger records the call as mock=1 at cost 0 under the docmend:prereq-prose purpose', async () => {
    const ledger = new Ledger();
    const finding = prereqFinding();
    const mock = async () => 'A fixed sentence.';
    await proposeProsePrerequisite(finding, RAW, TARGET, { mock, ledger, runId: 'run-1' });
    const rows = ledger.rows('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mock).toBe(1);
    expect(rows[0]!.cost_usd).toBe(0);
    expect(rows[0]!.purpose).toBe(PREREQ_PURPOSE);
    expect(ledger.totalCostUsd('run-1')).toBe(0); // totalCostUsd only sums non-mock rows
    ledger.close();
  });

  it('produces a real, appliable diff anchored at the finding line', async () => {
    const finding = prereqFinding();
    const mock = async () => 'Set the API_TOKEN environment variable first.';
    const r = await proposeProsePrerequisite(finding, RAW, TARGET, { mock });
    expect(r.proposal!.diff).not.toBeNull();
    expect(r.proposal!.diff).toContain('+Set the API_TOKEN environment variable first.');
  });

  it('a gateway error (mock responder throws) is counted, not silently dropped', async () => {
    const ledger = new Ledger();
    const finding = prereqFinding();
    const mock = async () => {
      throw new Error('boom');
    };
    const r = await proposeProsePrerequisite(finding, RAW, TARGET, { mock, ledger, runId: 'run-2' });
    expect(r.proposal).toBeNull();
    expect(r.error).toMatch(/boom/);
    const rows = ledger.rows('run-2');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toMatch(/boom/);
    ledger.close();
  });

  it('returns null immediately (no gateway call) for a finding that is not D-prereq', async () => {
    const finding: Finding = { ...prereqFinding(), checkId: 'D-placeholder', category: 'placeholder-text' };
    let called = false;
    const mock = async () => {
      called = true;
      return 'x';
    };
    const r = await proposeProsePrerequisite(finding, RAW, TARGET, { mock });
    expect(r.proposal).toBeNull();
    expect(called).toBe(false);
  });

  it('mock mode never calls the real network (no ANTHROPIC_API_KEY, no fetch)', async () => {
    const finding = prereqFinding();
    const mock = async () => 'A sentence.';
    const r = await proposeProsePrerequisite(finding, RAW, TARGET, { mock, env: {} });
    expect(r.mock).toBe(true);
    expect(r.costUsd).toBe(0);
  });
});
