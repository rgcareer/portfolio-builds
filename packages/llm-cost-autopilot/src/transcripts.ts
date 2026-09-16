// Extracts priceable LLM calls from Ryan's own Claude Code transcripts
// (~/.claude/projects/<dir>/<session>.jsonl) without ever holding a whole session file in
// memory: each line is read and JSON.parsed one at a time, never the file as a whole.
//
// A Claude Code transcript logs one JSONL line per event. An assistant API call can appear
// as more than one line (one per streamed content block); every line for the same call
// repeats the same `message.id` and the same cumulative `message.usage`, so grouping by
// message.id and keeping only the first occurrence de-duplicates without losing data.

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { sha256Hex, type TrafficRecord, type TrafficUsage } from '@portfolio-builds/shared';
import { isPricedModel } from './prices';

export type ExclusionReason = 'unpriced-model' | 'alias-model' | 'synthetic' | 'banned-model' | 'no-usage';

export type ExclusionTallies = Record<ExclusionReason, number>;

export interface ExtractWindow {
  from: string;
  to: string;
}

export interface ExtractResult {
  records: TrafficRecord[];
  tallies: ExclusionTallies;
}

const SYNTHETIC_MODEL = '<synthetic>';
const ALIAS_MODEL_RE = /^(sonnet|opus|fable)$/i;
const BANNED_MODEL_RE = /^claude-opus-5/;

function emptyTallies(): ExclusionTallies {
  return { 'unpriced-model': 0, 'alias-model': 0, synthetic: 0, 'banned-model': 0, 'no-usage': 0 };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface RawLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  message?: { id?: string; model?: string; usage?: RawUsage };
}

function toUsage(u: RawUsage): TrafficUsage {
  let cacheCreation5m = 0;
  let cacheCreation1h = 0;
  if (u.cache_creation) {
    cacheCreation5m = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
    cacheCreation1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
  } else if (typeof u.cache_creation_input_tokens === 'number') {
    cacheCreation5m = u.cache_creation_input_tokens;
  }
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreation5m,
    cacheCreation1h,
    output: u.output_tokens ?? 0,
  };
}

function dateOf(ts: string): string {
  return ts.slice(0, 10);
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listJsonlFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }
}

async function extractFile(
  filePath: string,
  projectToken: string,
  tokenizer: (v: string) => string,
  window: ExtractWindow,
  tallies: ExclusionTallies,
  out: TrafficRecord[],
): Promise<void> {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  const seenMessageIds = new Set<string>();
  const sessionTokenCache = new Map<string, string>();

  for await (const line of rl) {
    const text = line.trim();
    if (text === '') continue;

    let raw: RawLine;
    try {
      raw = JSON.parse(text) as RawLine;
    } catch {
      continue; // a malformed line never breaks extraction of the rest of the file
    }

    if (raw.type !== 'assistant') continue;
    const msg = raw.message;
    const msgId = msg?.id;
    if (!msgId) continue;
    if (seenMessageIds.has(msgId)) continue; // drop split-block duplicate
    seenMessageIds.add(msgId);

    if (!msg?.usage) {
      tallies['no-usage']++;
      continue;
    }
    const model = msg.model ?? '';
    if (model === SYNTHETIC_MODEL) {
      tallies.synthetic++;
      continue;
    }
    if (ALIAS_MODEL_RE.test(model)) {
      tallies['alias-model']++;
      continue;
    }
    if (BANNED_MODEL_RE.test(model)) {
      tallies['banned-model']++;
      continue;
    }
    if (!isPricedModel(model)) {
      tallies['unpriced-model']++;
      continue;
    }

    const ts = raw.timestamp ?? '';
    const d = dateOf(ts);
    if (d < window.from || d > window.to) continue; // outside the frozen window; not a pricing exclusion

    const sessionId = raw.sessionId ?? '';
    let sessionToken = sessionTokenCache.get(sessionId);
    if (sessionToken === undefined) {
      sessionToken = tokenizer(sessionId);
      sessionTokenCache.set(sessionId, sessionToken);
    }

    out.push({
      v: 1,
      id: sha256Hex(`${ts}|${model}|${msgId}`).slice(0, 16),
      ts,
      source: 'claude-code',
      provider: 'anthropic',
      model,
      purpose: null,
      runId: null,
      tenant: null,
      tags: { project: projectToken },
      latencyTolerant: false,
      session: sessionToken,
      sidechain: Boolean(raw.isSidechain),
      systemSha256: null,
      systemChars: null,
      userSha256: null,
      userChars: null,
      usage: toUsage(msg.usage),
      mock: false,
      error: null,
      cache: null,
    });
  }
}

/**
 * Streams every `<root>/<projectDir>/<session>.jsonl` transcript, de-duplicating and
 * classifying each assistant call. `tokenizer` should be bound to the salted HMAC (e.g.
 * `makeTokenizer(requireSalt())`) — this function never sees or requires the salt itself.
 */
export async function extractClaudeCode(root: string, tokenizer: (value: string) => string, window: ExtractWindow): Promise<ExtractResult> {
  const tallies = emptyTallies();
  const records: TrafficRecord[] = [];
  const projectTokenCache = new Map<string, string>();

  for (const dirName of listDirs(root)) {
    let projectToken = projectTokenCache.get(dirName);
    if (projectToken === undefined) {
      projectToken = tokenizer(dirName);
      projectTokenCache.set(dirName, projectToken);
    }
    const dirPath = resolve(root, dirName);
    for (const file of listJsonlFiles(dirPath)) {
      await extractFile(resolve(dirPath, file), projectToken, tokenizer, window, tallies, records);
    }
  }

  return { records, tallies };
}
