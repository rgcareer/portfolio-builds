// The never-throws LLM gateway with a hard per-run spend cap.
//
// Provenance: vendored 2026-09-10 from skillcheck/packages/core/src/llm.ts (itself a port
// of operation-hired/server/services/llm.js). Additions here: (1) PB_SPEND_CAP_USD, default
// 0 = mock mode, so no real call can happen until Ryan raises the cap for a piece; (2) a
// pre-call ceiling check and a post-call ledger total so the cap is enforced, not advisory;
// (3) mock responders so pipelines run end-to-end at $0 and every mock call is ledgered
// with mock=1; (4) the banned-model check on the call spec, not only the roster.
//
// callLlm() NEVER throws. It returns { content } on success or { error } on any failure
// (missing key, cap, API error, refusal, network), so every caller can fall back.

import { Ledger } from './ledger';
import { MODELS, computeCostUsd, estimateCostCeilingUsd, isBannedModel, type UsageTokens } from './models';

export const SPEND_CAP_ENV = 'PB_SPEND_CAP_USD';

export interface LlmSpec {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  temperature?: number;
}

export interface LlmResult {
  content: string | null;
  error: string | null;
  model: string;
  usage: UsageTokens | null;
  costUsd: number;
  mock: boolean;
}

export type MockResponder = (spec: LlmSpec) => string | Promise<string>;

export interface GatewayOptions {
  ledger?: Ledger;
  runId?: string | null;
  purpose?: string;
  /** When set, the call is answered locally, costs $0, and is ledgered with mock=1. */
  mock?: MockResponder;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable env for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Overrides the env cap (tests). */
  spendCapUsd?: number;
}

export function readSpendCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SPEND_CAP_ENV];
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function callLlm(spec: LlmSpec, opts: GatewayOptions = {}): Promise<LlmResult> {
  const env = opts.env ?? process.env;
  const model = spec.model || env['ANTHROPIC_MODEL'] || MODELS.opus;
  const purpose = opts.purpose ?? null;
  const runId = opts.runId ?? null;
  const cap = opts.spendCapUsd ?? readSpendCap(env);
  const maxTokens = spec.maxTokens ?? 900;

  const fail = (error: string, mock = false): LlmResult => {
    opts.ledger?.insert({ runId, provider: 'anthropic', model, purpose, usage: null, costUsd: 0, mock, error });
    return { content: null, error, model, usage: null, costUsd: 0, mock };
  };

  if (isBannedModel(model)) return fail(`Model policy violation: ${model} is banned (use ${MODELS.opus})`);

  if (opts.mock) {
    try {
      const content = await opts.mock(spec);
      opts.ledger?.insert({ runId, provider: 'anthropic', model, purpose, usage: null, costUsd: 0, mock: true, error: null });
      return { content, error: null, model, usage: null, costUsd: 0, mock: true };
    } catch (err) {
      return fail(`mock responder threw: ${(err as Error).message}`, true);
    }
  }

  if (cap <= 0) return fail(`mock-mode: ${SPEND_CAP_ENV} is 0 or unset; no real LLM call made`);

  const spentSoFar = opts.ledger ? opts.ledger.totalCostUsd() : 0;
  if (spentSoFar >= cap) {
    return fail(`spend-cap: already spent $${spentSoFar.toFixed(4)} of cap $${cap.toFixed(2)}`);
  }
  const ceiling = estimateCostCeilingUsd(model, spec.system.length + spec.user.length, maxTokens);
  if (spentSoFar + ceiling > cap) {
    return fail(`spend-cap: spent $${spentSoFar.toFixed(4)} + ceiling $${ceiling.toFixed(4)} would exceed cap $${cap.toFixed(2)}`);
  }

  const apiKey = env['ANTHROPIC_API_KEY'];
  if (!apiKey) return fail('Anthropic API key not configured');

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: spec.system,
      messages: [{ role: 'user', content: spec.user }],
    };
    if (typeof spec.temperature === 'number') body['temperature'] = spec.temperature;

    const response = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      return fail(`Anthropic API error (${response.status}): ${errText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      stop_reason?: string;
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    };

    const usage: UsageTokens = {
      input: data.usage?.input_tokens ?? 0,
      cacheRead: data.usage?.cache_read_input_tokens ?? 0,
      cacheCreation: data.usage?.cache_creation_input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    };
    const costUsd = computeCostUsd(model, usage);

    if (data.stop_reason === 'refusal') {
      opts.ledger?.insert({ runId, provider: 'anthropic', model, purpose, usage, costUsd, mock: false, error: 'refusal' });
      return { content: null, error: 'Anthropic API declined the request (refusal)', model, usage, costUsd, mock: false };
    }

    const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === 'text') : null;
    const content = textBlock?.text ?? '';
    opts.ledger?.insert({ runId, provider: 'anthropic', model, purpose, usage, costUsd, mock: false, error: null });
    return { content, error: null, model, usage, costUsd, mock: false };
  } catch (err) {
    return fail(`LLM request failed: ${(err as Error).message}`);
  }
}
