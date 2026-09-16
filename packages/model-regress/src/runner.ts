// Runs one condition (a model/prompt) over the golden set through the shared gateway, which
// NEVER throws: a gateway error becomes a failed item, and a spend-cap refusal mid-run marks
// that item and every remaining item skipped:'spend-cap' (achieved n is what completed —
// skips are disclosed, never padded). Each item's result normalizes to a shared RunRecord
// (source 'eval-item', verbatim) via toRunRecord.

import { callLlm, type Ledger, type MockResponder, type UsageTokens, type RunRecord, type RunUsage, type Turn, type RunStatus } from '@portfolio-builds/shared';
import { runAssertion } from './assertions';
import type { GoldenItem } from './golden';

export interface Condition {
  name: string;
  model: string;
  maxTokens: number;
}

export interface RunConditionOptions {
  ledger?: Ledger;
  mock?: MockResponder;
  env?: NodeJS.ProcessEnv;
  spendCapUsd?: number;
  onItem?: (result: ItemResult) => void;
  /** The frozen system prompt for the task. */
  system?: string;
  runId?: string | null;
  /** Injectable fetch for the real path in tests (offline); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ItemResult {
  index: number;
  id: string;
  model: string;
  content: string | null;
  error: string | null;
  costUsd: number;
  latencyMs: number;
  usage: UsageTokens | null;
  mock: boolean;
  passParse: boolean;
  passExact: boolean;
  skipped: null | 'spend-cap';
  at: string;
}

export interface ConditionRun {
  name: string;
  model: string;
  maxTokens: number;
  /** Items attempted (the set length). */
  n: number;
  /** Items that produced a real result (not skipped). */
  completed: number;
  /** exact-json passes among completed items (the headline binary). */
  k: number;
  /** json-parse passes among completed items. */
  kParse: number;
  skipped: number;
  errors: number;
  totalCostUsd: number;
  results: ItemResult[];
}

function isSpendCapError(error: string | null): boolean {
  return error !== null && error.includes('spend-cap');
}

export async function runCondition(
  set: readonly GoldenItem[],
  condition: Condition,
  opts: RunConditionOptions = {},
): Promise<ConditionRun> {
  const system = opts.system ?? '';
  const results: ItemResult[] = [];
  let capHit = false;

  for (const item of set) {
    const at = new Date().toISOString();
    if (capHit) {
      const skippedResult: ItemResult = {
        index: item.index,
        id: item.expected.id,
        model: condition.model,
        content: null,
        error: 'spend-cap: skipped after the cap was reached',
        costUsd: 0,
        latencyMs: 0,
        usage: null,
        mock: false,
        passParse: false,
        passExact: false,
        skipped: 'spend-cap',
        at,
      };
      results.push(skippedResult);
      opts.onItem?.(skippedResult);
      continue;
    }

    const started = performance.now();
    const res = await callLlm(
      { system, user: item.prompt, maxTokens: condition.maxTokens, model: condition.model },
      {
        ...(opts.ledger ? { ledger: opts.ledger } : {}),
        ...(opts.mock ? { mock: opts.mock } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.spendCapUsd !== undefined ? { spendCapUsd: opts.spendCapUsd } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        purpose: 'eval-item',
        runId: opts.runId ?? condition.name,
      },
    );
    const latencyMs = Math.max(0, Math.round(performance.now() - started));

    if (isSpendCapError(res.error)) {
      capHit = true;
      const skippedResult: ItemResult = {
        index: item.index,
        id: item.expected.id,
        model: condition.model,
        content: null,
        error: res.error,
        costUsd: 0,
        latencyMs,
        usage: null,
        mock: res.mock,
        passParse: false,
        passExact: false,
        skipped: 'spend-cap',
        at,
      };
      results.push(skippedResult);
      opts.onItem?.(skippedResult);
      continue;
    }

    const output = { content: res.content, costUsd: res.costUsd, latencyMs };
    const passParse = runAssertion({ kind: 'json-parse' }, output).pass;
    const passExact = runAssertion({ kind: 'exact-json', expected: item.expected }, output).pass;

    const result: ItemResult = {
      index: item.index,
      id: item.expected.id,
      model: condition.model,
      content: res.content,
      error: res.error,
      costUsd: res.costUsd,
      latencyMs,
      usage: res.usage,
      mock: res.mock,
      passParse,
      passExact,
      skipped: null,
      at,
    };
    results.push(result);
    opts.onItem?.(result);
  }

  const completed = results.filter((r) => r.skipped === null).length;
  const k = results.filter((r) => r.skipped === null && r.passExact).length;
  const kParse = results.filter((r) => r.skipped === null && r.passParse).length;
  const skipped = results.filter((r) => r.skipped !== null).length;
  const errors = results.filter((r) => r.skipped === null && r.error !== null).length;
  const totalCostUsd = results.reduce((a, r) => a + r.costUsd, 0);

  return {
    name: condition.name,
    model: condition.model,
    maxTokens: condition.maxTokens,
    n: set.length,
    completed,
    k,
    kParse,
    skipped,
    errors,
    totalCostUsd,
    results,
  };
}

/** Normalize one item result to a shared RunRecord (source 'eval-item', verbatim). */
export function toRunRecord(item: GoldenItem, result: ItemResult): RunRecord {
  const usage: RunUsage = {
    input: result.usage?.input ?? 0,
    output: result.usage?.output ?? 0,
    cacheRead: result.usage?.cacheRead ?? 0,
    cacheCreation: result.usage?.cacheCreation ?? 0,
  };

  const turn: Turn = { index: 0, kind: 'llm', at: result.at, model: result.model, usage, latencyMs: result.latencyMs };
  if (result.content !== null) turn.text = result.content;
  if (result.error !== null) turn.error = { class: result.skipped === 'spend-cap' ? 'spend-cap' : 'gateway-error' };

  const status: RunStatus = result.skipped !== null ? 'aborted' : result.error !== null ? 'errored' : 'completed';

  return {
    recordVersion: '1',
    runId: `${item.expected.id}#${result.index}`,
    source: { kind: 'eval-item', adapter: 'model-regress', schemaVersions: ['run-record-v1'] },
    redaction: 'verbatim',
    startedAt: result.at,
    endedAt: result.at,
    models: [result.model],
    turns: [turn],
    toolCalls: [],
    usage,
    costUsd: result.costUsd,
    outcome: { status },
    meta: {
      itemIndex: result.index,
      id: result.id,
      passExact: result.passExact,
      passParse: result.passParse,
      skipped: result.skipped,
      mock: result.mock,
    },
  };
}
