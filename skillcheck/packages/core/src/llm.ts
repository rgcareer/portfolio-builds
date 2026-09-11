// llm.ts — the never-throws LLM gateway, ported from operation-hired/server/services/llm.js.
//
// callLlm() NEVER throws: it returns { content } on success or { error } on any
// missing-key / API failure, so every caller can fall back to a deterministic path.
// The one upgrade over OH: per-call token+cost accounting is PERSISTED to the `calls`
// table (OH only logged to stderr), giving a real "cost per successful audit" number.
//
// Anthropic only — Skillcheck's sole LLM use (M2 haiku triage) is Claude. Perplexity is
// deliberately not ported. The M1 static pipeline makes no LLM calls; this is core infra
// built + tested now for M2.

import { randomUUID } from 'node:crypto';
import type { Db } from './db';
import { MODELS, computeCostUsd, type UsageTokens } from './models';

export interface LlmSpec {
  system: string;
  user: string;
  maxTokens?: number;
  provider?: string;
  model?: string;
  temperature?: number;
}

export interface LlmResult {
  content: string | null;
  error: string | null;
  provider: string;
  model: string;
  usage: UsageTokens | null;
  costUsd: number;
}

export interface CallOptions {
  /** When provided, one row is written to `calls` for the call (success or failure). */
  db?: Db;
  runId?: string | null;
  purpose?: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function resolveProvider(override?: string): string {
  return (override || process.env.SKILLCHECK_LLM_PROVIDER || 'anthropic').toLowerCase();
}

function persistCall(db: Db, row: {
  runId: string | null;
  provider: string;
  model: string;
  purpose: string | null;
  usage: UsageTokens | null;
  costUsd: number;
  error: string | null;
}): void {
  try {
    db.prepare(
      `INSERT INTO calls
        (id, run_id, provider, model, purpose, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, cost_usd, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      randomUUID(),
      row.runId,
      row.provider,
      row.model,
      row.purpose,
      row.usage?.input ?? 0,
      row.usage?.cacheRead ?? 0,
      row.usage?.cacheCreation ?? 0,
      row.usage?.output ?? 0,
      row.costUsd,
      row.error,
    );
  } catch {
    /* persistence must never break generation (OH invariant) */
  }
}

/**
 * Call the LLM. Never throws. On success returns { content, usage, costUsd }; on any
 * failure returns { error } with content null. Writes a `calls` row when opts.db is set.
 */
export async function callLlm(spec: LlmSpec, opts: CallOptions = {}): Promise<LlmResult> {
  const provider = resolveProvider(spec.provider);
  const doFetch = opts.fetchImpl ?? fetch;
  const purpose = opts.purpose ?? null;
  const runId = opts.runId ?? null;

  const fail = (model: string, error: string): LlmResult => {
    if (opts.db) persistCall(opts.db, { runId, provider, model, purpose, usage: null, costUsd: 0, error });
    return { content: null, error, provider, model, usage: null, costUsd: 0 };
  };

  if (provider !== 'anthropic') {
    return fail(spec.model ?? 'unknown', `Unsupported LLM provider: ${provider}`);
  }

  const model = spec.model || process.env.ANTHROPIC_MODEL || MODELS.opus;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail(model, 'Anthropic API key not configured');

  try {
    const body: Record<string, unknown> = {
      model,
      max_tokens: spec.maxTokens ?? 900,
      system: spec.system,
      messages: [{ role: 'user', content: spec.user }],
    };
    if (typeof spec.temperature === 'number') body['temperature'] = spec.temperature;

    const response = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      return fail(model, `Anthropic API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      stop_reason?: string;
      content?: { type: string; text?: string }[];
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens?: number;
      };
    };

    if (data.stop_reason === 'refusal') {
      return fail(model, 'Anthropic API declined the request (refusal)');
    }

    const usage: UsageTokens = {
      input: data.usage?.input_tokens ?? 0,
      cacheRead: data.usage?.cache_read_input_tokens ?? 0,
      cacheCreation: data.usage?.cache_creation_input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    };
    const costUsd = computeCostUsd(model, usage);
    const textBlock = Array.isArray(data.content)
      ? data.content.find((b) => b.type === 'text')
      : null;
    const content = textBlock?.text ?? '';

    if (opts.db) persistCall(opts.db, { runId, provider, model, purpose, usage, costUsd, error: null });
    return { content, error: null, provider, model, usage, costUsd };
  } catch (err) {
    return fail(model, `LLM request failed: ${(err as Error).message}`);
  }
}
