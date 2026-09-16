// Claude Code transcript adapter. Streams a JSONL session transcript into a redacted-by-
// construction RunRecord. Tolerant: blank lines are skipped, malformed lines and unknown
// record types are counted (never thrown), and every schema version is collected. No free
// text ever crosses into the record — only hashes, counts, enums, ISO timestamps, HMAC
// tokens. The output always satisfies parseRunRecord.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRunRecord } from '@portfolio-builds/shared';
import type { RunRecord, Turn, ToolCall, RunUsage, RunStatus, MetaScalar } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { makeTokenizers, keepScalar, errorClassOf, toolNameOf, type Tokenizers } from '../redact';

export interface ParseOptions {
  salt: string;
  protocol: Protocol;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?$/;
const FALLBACK_TS = '1970-01-01T00:00:00Z';
const SAFE_ENUM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/; // permissionMode / entrypoint enums
const VERSION_RE = /^[0-9]+(?:\.[0-9]+){0,3}(?:-[A-Za-z0-9.]+)?$/;

type AnyRec = Record<string, unknown>;

function isoOr(ts: unknown, fallback: string): string {
  return typeof ts === 'string' && ISO_RE.test(ts) ? ts : fallback;
}

function usageFrom(u: unknown): RunUsage | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as AnyRec;
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0);
  return {
    input: num('input_tokens'),
    output: num('output_tokens'),
    cacheRead: num('cache_read_input_tokens'),
    cacheCreation: num('cache_creation_input_tokens'),
  };
}

interface Group {
  turn: Turn;
  text: string;
  hasUsage: boolean;
}

/**
 * Parse a Claude Code transcript (array of JSONL lines, or one string with embedded
 * newlines) into a redacted RunRecord.
 */
export function parseTranscript(input: string[] | string, opts: ParseOptions): RunRecord {
  const { protocol } = opts;
  const salt = opts.salt;
  if (!salt || salt.length < 16) {
    throw new Error('parseTranscript: a salt of at least 16 characters is required (never commit it)');
  }
  const t: Tokenizers = makeTokenizers(salt);
  const lines = Array.isArray(input) ? input : input.split('\n');

  const turns: Turn[] = [];
  const toolCalls: ToolCall[] = [];
  const callById = new Map<string, ToolCall>();
  const groups = new Map<string, Group>();
  const seenResultUuids = new Set<string>();
  const schemaVersions = new Set<string>();
  const models = new Set<string>();

  // meta counters — all numbers, all disclosable, never free text.
  let malformedLines = 0;
  let unknownTypes = 0;
  let assistantRecords = 0;
  let llmTurns = 0;
  let promptTurns = 0;
  let metaPrompts = 0;
  let compactSummaries = 0;
  let thinkingBlocks = 0;
  let thinkingChars = 0;
  let bannedModelObserved = 0;
  let sidechainRecords = 0;
  let orphanResults = 0;
  let dedupedResults = 0;
  let hookErrorRecords = 0;
  let apiErrorRecords = 0;
  let refusalRecords = 0;
  let denials = 0;
  let interrupts = 0;
  let systemEvents = 0;

  let sessionId: string | null = null;
  let cwdTok: string | null = null;
  let branchHash: string | null = null;
  let permissionMode: string | null = null;
  let entrypoint: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  const pushTurn = (turn: Turn): number => {
    turn.index = turns.length;
    turns.push(turn);
    return turn.index;
  };

  const noteTs = (ts: string) => {
    if (!ISO_RE.test(ts)) return;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
  };

  const captureContext = (rec: AnyRec) => {
    if (sessionId === null && typeof rec['sessionId'] === 'string' && rec['sessionId']) sessionId = t.session(rec['sessionId']);
    if (cwdTok === null && typeof rec['cwd'] === 'string' && rec['cwd']) cwdTok = t.path(rec['cwd']);
    if (branchHash === null && typeof rec['gitBranch'] === 'string' && rec['gitBranch']) branchHash = t.branch(rec['gitBranch']);
    if (permissionMode === null && typeof rec['permissionMode'] === 'string' && SAFE_ENUM_RE.test(rec['permissionMode'])) permissionMode = rec['permissionMode'];
    if (entrypoint === null && typeof rec['entrypoint'] === 'string' && SAFE_ENUM_RE.test(rec['entrypoint'])) entrypoint = rec['entrypoint'];
    if (typeof rec['version'] === 'string' && VERSION_RE.test(rec['version'])) schemaVersions.add(rec['version']);
    if (rec['isSidechain'] === true) sidechainRecords++;
  };

  const emitHookErrors = (rec: AnyRec, at: string) => {
    if (Array.isArray(rec['hookErrors']) && rec['hookErrors'].length > 0) {
      hookErrorRecords++;
      pushTurn({ index: 0, kind: 'system_event', at, eventType: 'hook_error' });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let rec: AnyRec;
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        malformedLines++;
        continue;
      }
      rec = parsed as AnyRec;
    } catch {
      malformedLines++;
      continue;
    }

    captureContext(rec);
    const at = isoOr(rec['timestamp'], firstTs ?? FALLBACK_TS);
    noteTs(at);
    const type = rec['type'];

    if (type === 'assistant') {
      assistantRecords++;
      const msg = (rec['message'] as AnyRec | undefined) ?? {};
      const key = (typeof msg['id'] === 'string' && msg['id']) || (typeof rec['uuid'] === 'string' && rec['uuid']) || `a${turns.length}`;
      let group = groups.get(key);
      if (!group) {
        const turn: Turn = { index: 0, kind: 'llm', at };
        pushTurn(turn);
        group = { turn, text: '', hasUsage: false };
        groups.set(key, group);
        llmTurns++;
      }
      const turn = group.turn;

      // model (banned model observed → bucket + count, never store the raw string)
      const model = msg['model'];
      if (typeof model === 'string' && model.length > 0) {
        if (/claude-opus-5/.test(model)) {
          bannedModelObserved++;
          turn.model = 'excluded:banned-model';
          models.add('excluded:banned-model');
        } else if (SAFE_ENUM_RE.test(model)) {
          turn.model = model;
          models.add(model);
        }
      }
      if (typeof msg['stop_reason'] === 'string' && SAFE_ENUM_RE.test(msg['stop_reason'])) turn.stopReason = msg['stop_reason'];

      // usage: counted once per grouped message.
      const u = usageFrom(msg['usage']);
      if (u && !group.hasUsage) {
        turn.usage = u;
        group.hasUsage = true;
      }

      // blocks: ordered; text hashed, thinking counted, tool_use → ToolCall.
      const content = msg['content'];
      if (Array.isArray(content)) {
        for (const blk of content as AnyRec[]) {
          const bt = blk['type'];
          if (bt === 'text' && typeof blk['text'] === 'string') {
            group.text += blk['text'];
          } else if (bt === 'thinking' && typeof blk['thinking'] === 'string') {
            thinkingBlocks++;
            thinkingChars += (blk['thinking'] as string).length;
          } else if (bt === 'tool_use') {
            const rawId = typeof blk['id'] === 'string' && blk['id'] ? blk['id'] : `${key}:${toolCalls.length}`;
            const inputStr = JSON.stringify(blk['input'] ?? null);
            const call: ToolCall = {
              id: t.call(rawId),
              name: toolNameOf(blk['name'], protocol, t),
              callTurn: turn.index,
              resultTurn: null,
              inputHash: t.hash(inputStr),
              inputBytes: inputStr.length,
              resultHash: null,
              resultBytes: null,
              isError: false,
              errorClass: null,
              durationMs: null,
              interrupted: false,
              timedOut: false,
              denied: false,
              orphan: false,
            };
            toolCalls.push(call);
            callById.set(rawId, call);
          }
        }
      }
      if (group.text.length > 0) {
        turn.textHash = t.hash(group.text);
        turn.textChars = group.text.length;
      }
      if (rec['isApiErrorMessage'] === true) {
        apiErrorRecords++;
        pushTurn({ index: 0, kind: 'system_event', at, eventType: 'api_error', error: { class: 'api-error' } });
      }
      emitHookErrors(rec, at);
    } else if (type === 'user') {
      const msg = (rec['message'] as AnyRec | undefined) ?? {};
      const content = msg['content'];
      if (typeof content === 'string') {
        if (rec['isMeta'] === true) {
          metaPrompts++;
        } else if (rec['isCompactSummary'] === true) {
          compactSummaries++;
        } else {
          promptTurns++;
          pushTurn({ index: 0, kind: 'prompt', at, textHash: t.hash(content), textChars: content.length });
        }
      } else if (Array.isArray(content)) {
        for (const blk of content as AnyRec[]) {
          if (blk['type'] !== 'tool_result') continue;
          const recUuid = typeof rec['uuid'] === 'string' ? rec['uuid'] : '';
          const dedupeKey = `${recUuid}:${String(blk['tool_use_id'] ?? '')}`;
          if (recUuid && seenResultUuids.has(dedupeKey)) {
            dedupedResults++;
            continue;
          }
          if (recUuid) seenResultUuids.add(dedupeKey);

          const tur = (rec['toolUseResult'] as AnyRec | undefined) ?? undefined;
          const kept: Record<string, MetaScalar> = {};
          if (tur && typeof tur === 'object') {
            for (const [k, v] of Object.entries(tur)) {
              const keptVal = keepScalar(k, v, protocol);
              if (keptVal !== undefined) kept[k] = keptVal;
            }
          }
          const isError = blk['is_error'] === true;
          const rawErrText = `${String(blk['content'] ?? '')} ${String(tur?.['error'] ?? '')}`;
          const errorClass = isError ? errorClassOf(rawErrText, protocol) : null;
          const resultStr = JSON.stringify(blk['content'] ?? null);
          const resultTurn = pushTurn({ index: 0, kind: 'tool_result', at, ...(isError ? { error: { class: errorClass ?? 'other' } } : {}) });
          const denialKind = tur?.['toolDenialKind'] ?? blk['toolDenialKind'] ?? rec['toolDenialKind'];
          const denied = typeof denialKind === 'string' && denialKind.length > 0;
          const interrupted = kept['interrupted'] === true;
          const timedOut = kept['timedOutAfterMs'] !== undefined || errorClass === 'timeout';
          if (denied) denials++;
          if (interrupted) interrupts++;

          const useId = typeof blk['tool_use_id'] === 'string' ? blk['tool_use_id'] : '';
          const open = useId ? callById.get(useId) : undefined;
          if (open && open.resultTurn === null) {
            open.resultTurn = resultTurn;
            open.resultHash = t.hash(resultStr);
            open.resultBytes = resultStr.length;
            open.isError = isError;
            open.errorClass = errorClass;
            open.durationMs = typeof kept['durationMs'] === 'number' ? kept['durationMs'] : null;
            open.interrupted = interrupted;
            open.timedOut = timedOut;
            open.denied = denied;
          } else {
            orphanResults++;
            const orphan: ToolCall = {
              id: t.call(useId || `orphan:${toolCalls.length}`),
              name: 'unknown',
              callTurn: resultTurn,
              resultTurn,
              inputHash: t.hash(''),
              inputBytes: 0,
              resultHash: t.hash(resultStr),
              resultBytes: resultStr.length,
              isError,
              errorClass,
              durationMs: typeof kept['durationMs'] === 'number' ? kept['durationMs'] : null,
              interrupted,
              timedOut,
              denied,
              orphan: true,
            };
            toolCalls.push(orphan);
          }
        }
      }
      emitHookErrors(rec, at);
    } else if (type === 'system') {
      const subtype = rec['subtype'];
      if (typeof subtype === 'string' && subtype.length > 0) {
        if (subtype === 'api_error') {
          apiErrorRecords++;
          const status = typeof rec['status'] === 'number' ? rec['status'] : undefined;
          pushTurn({ index: 0, kind: 'system_event', at, eventType: 'api_error', error: status !== undefined ? { class: 'api-error', status } : { class: 'api-error' } });
        } else if (/^model_refusal/.test(subtype)) {
          refusalRecords++;
          pushTurn({ index: 0, kind: 'system_event', at, eventType: 'refusal' });
        } else if (SAFE_ENUM_RE.test(subtype)) {
          systemEvents++;
          pushTurn({ index: 0, kind: 'system_event', at, eventType: subtype });
          if (/compact/.test(subtype)) compactSummaries++;
        } else {
          systemEvents++;
          pushTurn({ index: 0, kind: 'system_event', at, eventType: 'other' });
        }
      }
      emitHookErrors(rec, at);
    } else if (type === 'summary') {
      compactSummaries++;
    } else {
      unknownTypes++;
      emitHookErrors(rec, at);
    }
  }

  // Refusal via llm stop reason (in addition to system model_refusal events).
  for (const turn of turns) {
    if (turn.kind === 'llm' && typeof turn.stopReason === 'string' && /refusal/.test(turn.stopReason)) {
      refusalRecords++;
    }
  }

  const usage = turns.reduce<RunUsage>(
    (acc, turn) => {
      if (turn.kind === 'llm' && turn.usage) {
        return {
          input: acc.input + turn.usage.input,
          output: acc.output + turn.usage.output,
          cacheRead: acc.cacheRead + turn.usage.cacheRead,
          cacheCreation: acc.cacheCreation + turn.usage.cacheCreation,
        };
      }
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );

  const startedAt = firstTs ?? FALLBACK_TS;
  const endedAt = lastTs ?? startedAt;
  const runId = sessionId ?? t.session(`anon:${startedAt}:${turns.length}`);

  const status: RunStatus =
    apiErrorRecords > 0 || refusalRecords > 0 ? 'errored' : interrupts > 0 ? 'aborted' : llmTurns > 0 ? 'completed' : 'unknown';

  const meta: Record<string, MetaScalar> = {
    malformedLines,
    unknownTypes,
    assistantRecords,
    llmTurns,
    promptTurns,
    metaPrompts,
    compactSummaries,
    thinkingBlocks,
    thinkingChars,
    bannedModelObserved,
    sidechainRecords,
    orphanResults,
    dedupedResults,
    hookErrorRecords,
    apiErrorRecords,
    refusalRecords,
    denials,
    interrupts,
    systemEvents,
    toolCalls: toolCalls.length,
  };
  if (cwdTok !== null) meta['cwdToken'] = cwdTok;
  if (branchHash !== null) meta['gitBranchHash'] = branchHash;
  if (permissionMode !== null) meta['permissionMode'] = permissionMode;
  if (entrypoint !== null) meta['entrypoint'] = entrypoint;

  const record: RunRecord = {
    recordVersion: '1',
    runId,
    source: {
      kind: 'claude-code-transcript',
      adapter: 'claude-code',
      schemaVersions: [...schemaVersions].sort(),
    },
    redaction: 'hashed',
    startedAt,
    endedAt,
    models: [...models].sort(),
    turns,
    toolCalls,
    usage,
    costUsd: null,
    outcome: { status },
    meta,
  };
  return parseRunRecord(record, 'claude-code-transcript');
}

export interface IngestResult {
  records: RunRecord[];
  totalFiles: number;
  excludedZeroAssistant: number;
  files: { name: string; runId: string; llmTurns: number; excluded: boolean }[];
}

function listJsonl(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d).sort()) {
      const full = resolve(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        walk(full);
      } else if (entry.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Ingest every *.jsonl transcript under `dir`. Files with zero assistant records are counted
 * and excluded (disclosed, never padded). Refuses without a salt; never writes anything.
 */
export function ingestClaudeCodeDir(
  dir: string,
  opts: ParseOptions & { onFile?: (name: string, record: RunRecord) => void },
): IngestResult {
  if (!opts.salt || opts.salt.length < 16) {
    throw new Error('ingestClaudeCodeDir: PB_ANON_SALT (>=16 chars) is required; refusing to ingest');
  }
  if (!existsSync(dir)) throw new Error(`ingestClaudeCodeDir: no such directory ${dir}`);
  const files = listJsonl(dir);
  const records: RunRecord[] = [];
  const fileInfos: IngestResult['files'] = [];
  let excludedZeroAssistant = 0;
  for (const full of files) {
    const name = full.slice(dir.length + 1);
    const record = parseTranscript(readFileSync(full, 'utf8'), opts);
    const llmTurns = Number(record.meta['llmTurns'] ?? 0);
    const excluded = Number(record.meta['assistantRecords'] ?? 0) === 0;
    fileInfos.push({ name, runId: record.runId, llmTurns, excluded });
    if (excluded) {
      excludedZeroAssistant++;
    } else {
      records.push(record);
      opts.onFile?.(name, record);
    }
  }
  return { records, totalFiles: files.length, excludedZeroAssistant, files: fileInfos };
}
