// One-time generator for fixtures/labeled/*.json — 40 labelled RunRecords under a FIXED test
// salt. Each scenario builds a synthetic Claude Code transcript, runs it through the real
// adapter (so every fixture is a genuine redacted RunRecord), and attaches `labels` = the
// detectors it was constructed to contain. The generator itself re-runs the detectors and
// FAILS if any detected set differs from its intended labels, so the committed fixtures are
// guaranteed to give precision = recall = 1. Run: node --import tsx test/fixtures/generate-labeled.ts
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '@portfolio-builds/shared';
import type { RunRecord } from '@portfolio-builds/shared';
import { loadProtocol, type DetectorName } from '../../src/protocol';
import { parseTranscript } from '../../src/adapters/claudeCode';
import { runDetectors, detectorSet } from '../../src/detectors';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../fixtures/labeled');
const SALT = 'fixtures-fixed-salt-abcdef123456';
const protocol = loadProtocol();

const BASE = Date.parse('2026-09-10T10:00:00.000Z');
class Session {
  private n = 0;
  private lines: string[] = [];
  constructor(private sid: string) {}
  private ts(): string {
    return new Date(BASE + this.n++ * 1000).toISOString();
  }
  private push(o: Record<string, unknown>): void {
    this.lines.push(JSON.stringify({ sessionId: this.sid, version: '2.0.14', timestamp: this.ts(), ...o }));
  }
  prompt(text: string): this {
    this.push({ type: 'user', uuid: `u${this.n}`, message: { role: 'user', content: text } });
    return this;
  }
  llmText(text: string, stop = 'end_turn'): this {
    this.push({
      type: 'assistant',
      uuid: `a${this.n}`,
      message: { id: `m${this.n}`, role: 'assistant', model: 'claude-opus-4-8', stop_reason: stop, usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text }] },
    });
    return this;
  }
  toolUse(callId: string, name: string, input: unknown): this {
    this.push({
      type: 'assistant',
      uuid: `a${this.n}`,
      message: { id: `m${this.n}`, role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: callId, name, input }] },
    });
    return this;
  }
  result(callId: string, content: string, opts: { isError?: boolean; toolUseResult?: Record<string, unknown> } = {}): this {
    const rec: Record<string, unknown> = { type: 'user', uuid: `u${this.n}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, is_error: opts.isError ?? false, content }] } };
    if (opts.toolUseResult) rec['toolUseResult'] = opts.toolUseResult;
    this.push(rec);
    return this;
  }
  system(subtype: string, extra: Record<string, unknown> = {}): this {
    this.push({ type: 'system', uuid: `s${this.n}`, subtype, ...extra });
    return this;
  }
  summary(): this {
    this.push({ type: 'summary', summary: 'compacted', leafUuid: 'x' });
    return this;
  }
  raw(o: Record<string, unknown>): this {
    this.push(o);
    return this;
  }
  build(): string[] {
    return this.lines;
  }
}

let counter = 0;
function sid(): string {
  counter++;
  return `0000000${counter}`.slice(-8) + '-9dad-41d1-89b4-00c04fd430c8';
}

interface Spec {
  name: string;
  labels: DetectorName[];
  lines: string[];
}
const specs: Spec[] = [];
const add = (name: string, labels: DetectorName[], s: Session) => specs.push({ name, labels, lines: s.build() });

// --- clean sessions (13) ---
for (let i = 0; i < 13; i++) {
  const s = new Session(sid()).prompt(`do task ${i}`).toolUse('c1', 'Read', { file: `f${i}.ts` }).result('c1', 'ok contents').llmText('done');
  if (i % 3 === 0) s.toolUse('c2', 'Bash', { command: `echo ${i}` }).result('c2', 'printed');
  add(`clean-${i}`, [], s);
}

// --- LOOP ---
{
  const s = new Session(sid()).prompt('loop');
  for (let i = 0; i < 3; i++) s.toolUse(`c${i}`, 'Bash', { command: 'status' }).result(`c${i}`, 'same output');
  s.llmText('stuck');
  add('loop-pos', ['LOOP'], s);
}
add('loop-neg', [], new Session(sid()).prompt('near').toolUse('c0', 'Bash', { command: 'status' }).result('c0', 'same').toolUse('c1', 'Bash', { command: 'status' }).result('c1', 'same').llmText('ok'));

// --- RETRY ---
{
  const s = new Session(sid()).prompt('retry');
  for (let i = 0; i < 3; i++) s.toolUse(`c${i}`, 'Bash', { command: `attempt ${i}` }).result(`c${i}`, `attempt ${i} failed exit code 1`, { isError: true });
  s.llmText('gave up');
  add('retry-pos', ['RETRY'], s);
}
add('retry-neg', [], new Session(sid()).prompt('near').toolUse('c0', 'Bash', { command: 'a0' }).result('c0', 'a0 exit code 1', { isError: true }).toolUse('c1', 'Bash', { command: 'a1' }).result('c1', 'a1 exit code 1', { isError: true }).toolUse('c2', 'Bash', { command: 'a2' }).result('c2', 'ok'));

// --- APIERR ---
add('apierr-pos', ['APIERR'], new Session(sid()).prompt('go').llmText('working', 'tool_use').system('api_error', { status: 529 }));
add('apierr-neg', [], new Session(sid()).prompt('go').llmText('done'));

// --- REFUSAL ---
add('refusal-stop-pos', ['REFUSAL'], new Session(sid()).prompt('bad ask').llmText('I cannot help with that', 'refusal'));
add('refusal-system-pos', ['REFUSAL'], new Session(sid()).prompt('bad ask').llmText('hmm', 'end_turn').system('model_refusal_hard'));
add('refusal-neg', [], new Session(sid()).prompt('ok ask').llmText('sure', 'end_turn'));

// --- DANGLE ---
add('dangle-pos', ['DANGLE'], new Session(sid()).prompt('run').toolUse('c0', 'Bash', { command: 'sleep 999' }).llmText('waiting', 'tool_use'));
add('dangle-neg', [], new Session(sid()).prompt('run').toolUse('c0', 'Bash', { command: 'ls' }).result('c0', 'listing').llmText('done'));

// --- HOOKERR ---
add('hookerr-pos', ['HOOKERR'], new Session(sid()).prompt('edit').llmText('editing', 'tool_use').raw({ type: 'system', uuid: 'h1', subtype: 'hook', hookErrors: ['PreToolUse blocked'] }));
add('hookerr-neg', [], new Session(sid()).prompt('edit').llmText('done').raw({ type: 'system', uuid: 'h1', subtype: 'hook', hookErrors: [] }));

// --- TIMEOUT ---
add('timeout-pos', ['TIMEOUT'], new Session(sid()).prompt('slow').toolUse('c0', 'Bash', { command: 'sleep 300' }).result('c0', 'Command timed out after 2m', { isError: true, toolUseResult: { timedOutAfterMs: 120000 } }).llmText('slow'));
add('timeout-neg', [], new Session(sid()).prompt('fast').toolUse('c0', 'Bash', { command: 'echo hi' }).result('c0', 'hi', { toolUseResult: { durationMs: 5 } }).llmText('ok'));

// --- TOOLERR (>=5 calls, >=2 errors, not 3-consecutive) ---
{
  const s = new Session(sid()).prompt('flaky');
  for (let i = 0; i < 6; i++) {
    const isError = i === 1 || i === 4;
    s.toolUse(`c${i}`, 'Bash', { command: `cmd${i}` }).result(`c${i}`, isError ? `cmd${i} exit code 1` : `cmd${i} ok`, { isError });
  }
  s.llmText('mixed');
  add('toolerr-pos', ['TOOLERR'], s);
}
{
  const s = new Session(sid()).prompt('mostly ok');
  for (let i = 0; i < 6; i++) {
    const isError = i === 2;
    s.toolUse(`c${i}`, 'Bash', { command: `cmd${i}` }).result(`c${i}`, isError ? `cmd${i} exit code 1` : `cmd${i} ok`, { isError });
  }
  s.llmText('fine');
  add('toolerr-neg', [], s);
}

// --- DENIAL ---
add('denial-pos', ['DENIAL'], new Session(sid()).prompt('rm').toolUse('c0', 'Bash', { command: 'rm -rf /' }).result('c0', 'denied by policy', { toolUseResult: { toolDenialKind: 'permission' } }).llmText('blocked'));
add('denial-neg', [], new Session(sid()).prompt('ls').toolUse('c0', 'Bash', { command: 'ls' }).result('c0', 'ok').llmText('done'));

// --- INTERRUPT ---
add('interrupt-pos', ['INTERRUPT'], new Session(sid()).prompt('go').toolUse('c0', 'Bash', { command: 'long task' }).result('c0', 'partial', { toolUseResult: { interrupted: true, durationMs: 10 } }).llmText('stopped'));
add('interrupt-neg', [], new Session(sid()).prompt('go').toolUse('c0', 'Bash', { command: 'quick' }).result('c0', 'done', { toolUseResult: { interrupted: false } }).llmText('ok'));

// --- COMPACT ---
add('compact-pos', ['COMPACT'], new Session(sid()).summary().prompt('after compaction').llmText('resumed'));
add('compact-neg', [], new Session(sid()).prompt('short').llmText('done'));

// --- multi-signature ---
{
  const s = new Session(sid()).prompt('loop and dangle');
  for (let i = 0; i < 3; i++) s.toolUse(`c${i}`, 'Bash', { command: 'poll' }).result(`c${i}`, 'same');
  s.toolUse('d0', 'Read', { file: 'x' }).llmText('hang', 'tool_use');
  add('loop+dangle', ['DANGLE', 'LOOP'], s);
}
add('apierr+refusal', ['APIERR', 'REFUSAL'], new Session(sid()).prompt('x').llmText('no', 'refusal').system('api_error', { status: 500 }));
{
  const s = new Session(sid()).prompt('timeouts');
  for (let i = 0; i < 3; i++) s.toolUse(`c${i}`, 'Bash', { command: `try ${i}` }).result(`c${i}`, `try ${i} timed out`, { isError: true, toolUseResult: { timedOutAfterMs: 60000 } });
  s.llmText('slow');
  add('retry+timeout', ['RETRY', 'TIMEOUT'], s);
}
{
  const s = new Session(sid()).prompt('hook and dangle').toolUse('c0', 'Edit', { file: 'a' }).llmText('editing', 'tool_use').raw({ type: 'system', uuid: 'h1', subtype: 'hook', hookErrors: ['blocked'] });
  add('hookerr+dangle', ['DANGLE', 'HOOKERR'], s);
}

// --- generate + verify ---
if (existsSync(OUT)) for (const f of readdirSync(OUT)) if (f.endsWith('.json')) rmSync(resolve(OUT, f));
mkdirSync(OUT, { recursive: true });

let idx = 0;
let failures = 0;
for (const spec of specs) {
  const base = parseTranscript(spec.lines, { salt: SALT, protocol });
  const record: RunRecord = { ...base, labels: [...spec.labels].sort() };
  const detected = detectorSet(runDetectors(record, protocol));
  const want = [...spec.labels].sort().join(',');
  const got = detected.join(',');
  if (want !== got) {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`MISMATCH ${spec.name}: want [${want}] got [${got}]`);
  }
  const fname = `${String(++idx).padStart(2, '0')}-${spec.name}.json`;
  writeFileSync(resolve(OUT, fname), stableStringify(record));
}
// eslint-disable-next-line no-console
console.log(`wrote ${specs.length} labeled fixtures to ${OUT}${failures ? ` — ${failures} MISMATCHES` : ' — all detector sets match labels'}`);
if (failures > 0) process.exit(1);
