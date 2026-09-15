// RunRecord v1: the shared normalized format for one agent/eval run, consumed by the
// failure-forensics tool (produced from Claude Code transcripts and agenteval traces) and
// by the model-regress detector (one record per eval item run).
//
// It deliberately supersedes agenteval's Agent Trace v1 (frozen upstream, no privacy mode,
// no latency, no error classes) with lossless fromAgentTrace/toAgentTrace so agenteval's
// checkers stay usable. The load-bearing invariant is privacy: a record whose redaction is
// 'hashed' must carry NO free text on any turn — only hashes, lengths, enums, ISO
// timestamps, and HMAC-shaped tokens. parseRunRecord enforces it and throws otherwise.

export type RunRecordSourceKind = 'claude-code-transcript' | 'agent-trace-v1' | 'eval-item';
export type Redaction = 'hashed' | 'verbatim';
export type TurnKind = 'prompt' | 'llm' | 'tool_call' | 'tool_result' | 'handoff' | 'gate' | 'system_event';
export type RunStatus = 'completed' | 'aborted' | 'errored' | 'unknown';

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface TurnError {
  class: string;
  status?: number;
}

export interface Turn {
  index: number;
  kind: TurnKind;
  at: string;
  model?: string;
  stopReason?: string;
  usage?: RunUsage;
  latencyMs?: number;
  textHash?: string;
  textChars?: number;
  /** Only legal when the record's redaction is 'verbatim'. */
  text?: string;
  eventType?: string;
  error?: TurnError;
}

export interface ToolCall {
  id: string;
  name: string;
  callTurn: number;
  resultTurn: number | null;
  inputHash: string;
  inputBytes: number;
  resultHash: string | null;
  resultBytes: number | null;
  isError: boolean;
  errorClass: string | null;
  durationMs: number | null;
  interrupted: boolean;
  timedOut: boolean;
  denied: boolean;
  orphan: boolean;
}

export interface RunRecordSource {
  kind: RunRecordSourceKind;
  adapter: string;
  schemaVersions: string[];
}

export type MetaScalar = string | number | boolean | null;

export interface RunRecord {
  recordVersion: '1';
  runId: string;
  source: RunRecordSource;
  redaction: Redaction;
  startedAt: string;
  endedAt: string;
  models: string[];
  turns: Turn[];
  toolCalls: ToolCall[];
  usage: RunUsage;
  costUsd: number | null;
  outcome: { status: RunStatus };
  labels?: string[];
  meta: Record<string, MetaScalar>;
}

export class RunRecordParseError extends Error {
  readonly context: string;
  constructor(context: string, message: string) {
    super(`RunRecord parse error [${context}]: ${message}`);
    this.context = context;
  }
}

export interface Issue {
  path: string;
  message: string;
}

const HMAC_TOKEN_RE = /^[a-z]_[0-9a-f]{6,64}$/; // e.g. s_ab12cd34ef, c_..., h_..., p_...
const HASH_RE = /^[0-9a-f]{16,64}$/; // hex digests (12–64 hex chars accepted by the tokenizer/sha256)
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?$/;

function isScalar(v: unknown): v is MetaScalar {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isUsage(u: unknown): boolean {
  if (u === undefined) return true;
  if (u === null || typeof u !== 'object') return false;
  const o = u as Record<string, unknown>;
  return (['input', 'output', 'cacheRead', 'cacheCreation'] as const).every(
    (k) => typeof o[k] === 'number' && Number.isFinite(o[k] as number) && (o[k] as number) >= 0,
  );
}

/** Returns problems without throwing. Empty array means valid. */
export function validateRunRecord(rec: unknown): Issue[] {
  const issues: Issue[] = [];
  if (rec === null || typeof rec !== 'object') return [{ path: '', message: 'record must be an object' }];
  const r = rec as Record<string, unknown>;
  if (r['recordVersion'] !== '1') issues.push({ path: 'recordVersion', message: "must be '1'" });
  if (typeof r['runId'] !== 'string' || (r['runId'] as string).length === 0) issues.push({ path: 'runId', message: 'must be a non-empty string' });

  const src = r['source'] as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') issues.push({ path: 'source', message: 'must be an object' });
  else {
    if (!['claude-code-transcript', 'agent-trace-v1', 'eval-item'].includes(src['kind'] as string))
      issues.push({ path: 'source.kind', message: 'invalid' });
    if (typeof src['adapter'] !== 'string') issues.push({ path: 'source.adapter', message: 'must be a string' });
    if (!Array.isArray(src['schemaVersions'])) issues.push({ path: 'source.schemaVersions', message: 'must be an array' });
  }

  const redaction = r['redaction'];
  if (redaction !== 'hashed' && redaction !== 'verbatim') issues.push({ path: 'redaction', message: "must be 'hashed' or 'verbatim'" });
  const verbatimAllowed = src && (src['kind'] === 'eval-item' || src['kind'] === 'agent-trace-v1');
  if (redaction === 'verbatim' && !verbatimAllowed)
    issues.push({ path: 'redaction', message: "'verbatim' is only legal for eval-item or agent-trace-v1 sources" });

  if (!isUsage(r['usage'])) issues.push({ path: 'usage', message: 'must be a usage object' });

  if (!Array.isArray(r['turns'])) issues.push({ path: 'turns', message: 'must be an array' });
  else {
    let llmSum: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let sawLlmUsage = false;
    (r['turns'] as unknown[]).forEach((t, i) => {
      const turn = t as Record<string, unknown>;
      const p = `turns[${i}]`;
      if (typeof turn['index'] !== 'number') issues.push({ path: `${p}.index`, message: 'must be a number' });
      if (!['prompt', 'llm', 'tool_call', 'tool_result', 'handoff', 'gate', 'system_event'].includes(turn['kind'] as string))
        issues.push({ path: `${p}.kind`, message: 'invalid' });
      if (typeof turn['at'] !== 'string' || !ISO_RE.test(turn['at'] as string)) issues.push({ path: `${p}.at`, message: 'must be an ISO timestamp' });
      if (redaction === 'hashed' && turn['text'] !== undefined) issues.push({ path: `${p}.text`, message: 'forbidden when redaction is hashed' });
      if (turn['textHash'] !== undefined && !HASH_RE.test(turn['textHash'] as string)) issues.push({ path: `${p}.textHash`, message: 'must be a hex hash' });
      if (turn['usage'] !== undefined && !isUsage(turn['usage'])) issues.push({ path: `${p}.usage`, message: 'invalid usage' });
      if (turn['kind'] === 'llm' && isUsage(turn['usage']) && turn['usage']) {
        const u = turn['usage'] as RunUsage;
        llmSum = {
          input: llmSum.input + u.input,
          output: llmSum.output + u.output,
          cacheRead: llmSum.cacheRead + u.cacheRead,
          cacheCreation: llmSum.cacheCreation + u.cacheCreation,
        };
        sawLlmUsage = true;
      }
    });
    // usage must equal the sum over llm turns (when any llm turn carried usage)
    if (sawLlmUsage && isUsage(r['usage'])) {
      const top = r['usage'] as RunUsage;
      for (const k of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) {
        if (top[k] !== llmSum[k]) issues.push({ path: `usage.${k}`, message: `must equal sum over llm turns (${llmSum[k]}), got ${top[k]}` });
      }
    }
  }

  if (!Array.isArray(r['toolCalls'])) issues.push({ path: 'toolCalls', message: 'must be an array' });
  else {
    (r['toolCalls'] as unknown[]).forEach((c, i) => {
      const call = c as Record<string, unknown>;
      const p = `toolCalls[${i}]`;
      if (typeof call['id'] !== 'string') issues.push({ path: `${p}.id`, message: 'must be a string' });
      if (typeof call['name'] !== 'string') issues.push({ path: `${p}.name`, message: 'must be a string' });
      if (redaction === 'hashed') {
        if (!HASH_RE.test(call['inputHash'] as string)) issues.push({ path: `${p}.inputHash`, message: 'must be a hex hash' });
        if (call['resultHash'] !== null && !HASH_RE.test(call['resultHash'] as string))
          issues.push({ path: `${p}.resultHash`, message: 'must be a hex hash or null' });
      }
    });
  }

  const meta = r['meta'];
  if (meta === null || typeof meta !== 'object') issues.push({ path: 'meta', message: 'must be an object' });
  else for (const [k, v] of Object.entries(meta as Record<string, unknown>)) if (!isScalar(v)) issues.push({ path: `meta.${k}`, message: 'must be a scalar' });

  return issues;
}

/** Parse-and-validate: returns the typed record or throws RunRecordParseError. */
export function parseRunRecord(rec: unknown, context = 'record'): RunRecord {
  const issues = validateRunRecord(rec);
  if (issues.length > 0) throw new RunRecordParseError(context, issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  return rec as RunRecord;
}

/** True when every hashed-record id/token has the expected HMAC or hash shape. */
export function isTokenShaped(value: string): boolean {
  return HMAC_TOKEN_RE.test(value) || HASH_RE.test(value);
}

// ---- Agent Trace v1 interop (lossless where the shapes overlap) --------------------------
// Agent Trace v1 (agenteval): { traceId, steps: [{ kind: 'llm'|'tool_call'|'tool_result'|
// 'handoff'|'gate', ... }] }. We map steps to turns 1:1 and back. verbatim only.

export interface AgentTraceStep {
  kind: 'llm' | 'tool_call' | 'tool_result' | 'handoff' | 'gate';
  at?: string;
  model?: string;
  text?: string;
  stopReason?: string;
  usage?: Partial<RunUsage>;
  name?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

export interface AgentTraceV1 {
  traceId: string;
  startedAt?: string;
  endedAt?: string;
  steps: AgentTraceStep[];
}

// Build a typed object from a bag, dropping keys whose value is undefined. Keeps
// exactOptionalPropertyTypes happy: an optional field is absent rather than set to undefined.
function compact<T>(bag: Record<string, unknown>): T {
  for (const k of Object.keys(bag)) if (bag[k] === undefined) delete bag[k];
  return bag as unknown as T;
}

export function fromAgentTrace(trace: AgentTraceV1, adapter = 'agent-trace-v1'): RunRecord {
  const turns: Turn[] = [];
  const toolCalls: ToolCall[] = [];
  const models = new Set<string>();
  let usage: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const at0 = trace.startedAt ?? '1970-01-01T00:00:00Z';
  trace.steps.forEach((s, i) => {
    const at = s.at ?? at0;
    if (s.kind === 'llm') {
      if (s.model) models.add(s.model);
      const u: RunUsage = {
        input: s.usage?.input ?? 0,
        output: s.usage?.output ?? 0,
        cacheRead: s.usage?.cacheRead ?? 0,
        cacheCreation: s.usage?.cacheCreation ?? 0,
      };
      usage = { input: usage.input + u.input, output: usage.output + u.output, cacheRead: usage.cacheRead + u.cacheRead, cacheCreation: usage.cacheCreation + u.cacheCreation };
      turns.push(compact<Turn>({ index: i, kind: 'llm', at, model: s.model, stopReason: s.stopReason, usage: u, text: s.text }));
    } else if (s.kind === 'tool_call') {
      turns.push(compact<Turn>({ index: i, kind: 'tool_call', at, text: s.text }));
      toolCalls.push({
        id: `t${i}`,
        name: s.name ?? 'unknown',
        callTurn: i,
        resultTurn: null,
        inputHash: '',
        inputBytes: s.input ? JSON.stringify(s.input).length : 0,
        resultHash: null,
        resultBytes: null,
        isError: false,
        errorClass: null,
        durationMs: null,
        interrupted: false,
        timedOut: false,
        denied: false,
        orphan: true,
      });
    } else if (s.kind === 'tool_result') {
      turns.push(compact<Turn>({ index: i, kind: 'tool_result', at, text: s.text, error: s.isError ? { class: 'tool-error' } : undefined }));
      const open = [...toolCalls].reverse().find((c) => c.resultTurn === null);
      if (open) {
        open.resultTurn = i;
        open.orphan = false;
        open.isError = Boolean(s.isError);
        open.resultBytes = s.output ? JSON.stringify(s.output).length : 0;
      }
    } else {
      turns.push(compact<Turn>({ index: i, kind: s.kind === 'handoff' ? 'handoff' : 'gate', at, text: s.text }));
    }
  });
  return {
    recordVersion: '1',
    runId: trace.traceId,
    source: { kind: 'agent-trace-v1', adapter, schemaVersions: ['agent-trace-v1'] },
    redaction: 'verbatim',
    startedAt: trace.startedAt ?? at0,
    endedAt: trace.endedAt ?? turns[turns.length - 1]?.at ?? at0,
    models: [...models],
    turns,
    toolCalls,
    usage,
    costUsd: null,
    outcome: { status: 'unknown' },
    meta: {},
  };
}

export function toAgentTrace(record: RunRecord): AgentTraceV1 {
  const steps: AgentTraceStep[] = record.turns
    .filter((t) => ['llm', 'tool_call', 'tool_result', 'handoff', 'gate'].includes(t.kind))
    .map((t) => {
      if (t.kind === 'llm') return compact<AgentTraceStep>({ kind: 'llm', at: t.at, model: t.model, text: t.text, stopReason: t.stopReason, usage: t.usage });
      if (t.kind === 'tool_call') {
        const call = record.toolCalls.find((c) => c.callTurn === t.index);
        return compact<AgentTraceStep>({ kind: 'tool_call', at: t.at, name: call?.name, text: t.text });
      }
      if (t.kind === 'tool_result') return compact<AgentTraceStep>({ kind: 'tool_result', at: t.at, text: t.text, isError: Boolean(t.error) });
      return compact<AgentTraceStep>({ kind: t.kind === 'handoff' ? 'handoff' : 'gate', at: t.at, text: t.text });
    });
  return { traceId: record.runId, startedAt: record.startedAt, endedAt: record.endedAt, steps };
}
