// Shared test support: a tiny Claude Code transcript builder + adapter shortcut. Not a test
// suite (vitest only picks up *.test.ts).
import { loadProtocol } from '../src/protocol';
import { parseTranscript } from '../src/adapters/claudeCode';
import type { RunRecord } from '@portfolio-builds/shared';

export const protocol = loadProtocol();
export const SALT = 'test-salt-fixed-0123456789';

const BASE = Date.parse('2026-09-10T10:00:00.000Z');

export class Session {
  private n = 0;
  private lines: string[] = [];
  constructor(private sid = 'ffffffff-9dad-41d1-89b4-00c04fd430c8') {}
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
  llm(text: string, stop = 'end_turn'): this {
    this.push({ type: 'assistant', uuid: `a${this.n}`, message: { id: `m${this.n}`, role: 'assistant', model: 'claude-opus-4-8', stop_reason: stop, usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text }] } });
    return this;
  }
  toolUse(callId: string, name: string, input: unknown): this {
    this.push({ type: 'assistant', uuid: `a${this.n}`, message: { id: `m${this.n}`, role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: callId, name, input }] } });
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
  raw(o: Record<string, unknown>): this {
    this.push(o);
    return this;
  }
  lines_(): string[] {
    return this.lines;
  }
  build(): RunRecord {
    return parseTranscript(this.lines, { salt: SALT, protocol });
  }
}

export const sess = (sid?: string) => new Session(sid);
