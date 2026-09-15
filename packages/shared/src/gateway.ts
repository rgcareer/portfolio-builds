// The never-throws LLM gateway with a hard per-run spend cap.
//
// Provenance: vendored 2026-09-10 from skillcheck/packages/core/src/llm.ts (itself a port
// of operation-hired/server/services/llm.js). Additions here: (1) PB_SPEND_CAP_USD, default
// 0 = mock mode, so no real call can happen until Ryan raises the cap for a piece; (2) a
// pre-call ceiling check and a post-call ledger total so the cap is enforced, not advisory;
// (3) mock responders so pipelines run end-to-end at $0 and every mock call is ledgered
// with mock=1; (4) the banned-model check on the call spec, not only the roster.
//
// 2026-09-15 additions (Phase 0 of the five-app build): (5) an optional TrafficSink so the
// cost autopilot and semantic cache can price/observe real traffic — one content-free
// TrafficRecord per call, auto-appended when PB_TRAFFIC_LOG names a file; (6) spec.cacheSystem
// sends the system prompt as a cached text block and the response's ephemeral 5m/1h cache
// creation is captured into the TrafficRecord; (7) temperature is no longer forwarded
// (removed on 4.6+ models: a 400). callLlm() still NEVER throws.

import { Ledger } from './ledger';
import { MODELS, computeCostUsd, estimateCostCeilingUsd, isBannedModel, type UsageTokens } from './models';
import { sha256Hex } from './stableJson';
import { JsonlTrafficSink, type TrafficSink, type TrafficRecord, type TrafficUsage } from './traffic';

export const SPEND_CAP_ENV = 'PB_SPEND_CAP_USD';
export const TRAFFIC_LOG_ENV = 'PB_TRAFFIC_LOG';

export interface LlmSpec {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  /** Send the system prompt as a cached text block (cache_control: ephemeral). */
  cacheSystem?: boolean;
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
  /** Content-free traffic capture. Defaults to a JSONL sink at PB_TRAFFIC_LOG when set. */
  capture?: TrafficSink;
  tenant?: string | null;
  tags?: Record<string, string>;
  latencyTolerant?: boolean;
  /** HMAC session token (never a raw session id). */
  session?: string | null;
}

export function readSpendCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SPEND_CAP_ENV];
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

let trafficSeq = 0;

function toTrafficUsage(u: UsageTokens | null, eph5m: number, eph1h: number): TrafficUsage | null {
  if (!u) return null;
  const cacheCreation = u.cacheCreation ?? 0;
  // Prefer the response's ephemeral split; fall back to attributing all creation to 5m.
  const has = eph5m + eph1h > 0;
  return {
    input: u.input ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheCreation5m: has ? eph5m : cacheCreation,
    cacheCreation1h: has ? eph1h : 0,
    output: u.output ?? 0,
  };
}

function emitTraffic(
  opts: GatewayOptions,
  sink: TrafficSink | null,
  spec: LlmSpec,
  model: string,
  usage: UsageTokens | null,
  eph5m: number,
  eph1h: number,
  mock: boolean,
  error: string | null,
): void {
  if (!sink) return;
  try {
    const ts = new Date().toISOString();
    const seq = trafficSeq++;
    const rec: TrafficRecord = {
      v: 1,
      id: sha256Hex(`${ts}|${model}|${seq}`).slice(0, 16),
      ts,
      source: 'gateway',
      provider: 'anthropic',
      model,
      purpose: opts.purpose ?? null,
      runId: opts.runId ?? null,
      tenant: opts.tenant ?? null,
      tags: opts.tags ?? {},
      latencyTolerant: opts.latencyTolerant ?? false,
      session: opts.session ?? null,
      sidechain: false,
      systemSha256: sha256Hex(spec.system),
      systemChars: spec.system.length,
      userSha256: sha256Hex(spec.user),
      userChars: spec.user.length,
      usage: toTrafficUsage(usage, eph5m, eph1h),
      mock,
      error,
      cache: null,
    };
    sink.append(rec);
  } catch {
    /* capture is best-effort and never breaks a call */
  }
}

export async function callLlm(spec: LlmSpec, opts: GatewayOptions = {}): Promise<LlmResult> {
  const env = opts.env ?? process.env;
  const model = spec.model || env['ANTHROPIC_MODEL'] || MODELS.opus;
  const purpose = opts.purpose ?? null;
  const runId = opts.runId ?? null;
  const cap = opts.spendCapUsd ?? readSpendCap(env);
  const maxTokens = spec.maxTokens ?? 900;

  const logPath = env[TRAFFIC_LOG_ENV];
  const sink: TrafficSink | null = opts.capture ?? (logPath ? new JsonlTrafficSink(logPath) : null);

  const fail = (error: string, mock = false): LlmResult => {
    opts.ledger?.insert({ runId, provider: 'anthropic', model, purpose, usage: null, costUsd: 0, mock, error });
    emitTraffic(opts, sink, spec, model, null, 0, 0, mock, error);
    return { content: null, error, model, usage: null, costUsd: 0, mock };
  };

  if (isBannedModel(model)) return fail(`Model policy violation: ${model} is banned (use ${MODELS.opus})`);

  if (opts.mock) {
    try {
      const content = await opts.mock(spec);
      opts.ledger?.insert({ runId, provider: 'anthropic', model, purpose, usage: null, costUsd: 0, mock: true, error: null });
      emitTraffic(opts, sink, spec, model, null, 0, 0, true, null);
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
    const systemField = spec.cacheSystem
      ? [{ type: 'text', text: spec.system, cache_control: { type: 'ephemeral' } }]
      : spec.system;
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: systemField,
      messages: [{ role: 'user', content: spec.user }],
    };

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
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens?: number;
        cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
      };
    };

    const usage: UsageTokens = {
      input: data.usage?.input_tokens ?? 0,
      cacheRead: data.usage?.cache_read_input_tokens ?? 0,
      cacheCreation: data.usage?.cache_creation_input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    };
    const eph5m = data.usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const eph1h = data.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const costUsd = computeCostUsd(model, usage);

    if (data.stop_reason === 'refusal') {
      opts.ledger?.insert({ runId, provider: 'anthropic', model, purpose, usage, costUsd, mock: false, error: 'refusal' });
      emitTraffic(opts, sink, spec, model, usage, eph5m, eph1h, false, 'refusal');
      return { content: null, error: 'Anthropic API declined the request (refusal)', model, usage, costUsd, mock: false };
    }

    const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === 'text') : null;
    const content = textBlock?.text ?? '';
    opts.ledger?.insert({ runId, provider: 'anthropic', model, purpose, usage, costUsd, mock: false, error: null });
    emitTraffic(opts, sink, spec, model, usage, eph5m, eph1h, false, null);
    return { content, error: null, model, usage, costUsd, mock: false };
  } catch (err) {
    return fail(`LLM request failed: ${(err as Error).message}`);
  }
}
