import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { protocol, sess } from './helpers';
import { runCli } from '../src/cli';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures');
const LABELED = resolve(HERE, '../fixtures/labeled');
const SALT = 'cli-fixed-salt-0123456789';

function capture() {
  const lines: string[] = [];
  return { sink: (s: string) => lines.push(s), text: () => lines.join('\n') };
}
const base = (over: Record<string, unknown> = {}) => ({ protocol, env: {}, cwd: HERE, out: () => {}, err: () => {}, ...over });

const loopFixture = () => resolve(LABELED, readdirSync(LABELED).find((f) => f.includes('loop-pos'))!);
const cleanFixture = () => resolve(LABELED, readdirSync(LABELED).find((f) => f.includes('clean'))!);

describe('cli', () => {
  it('convert --from agent-trace emits a RunRecord (exit 0)', async () => {
    const out = capture();
    const code = await runCli(['convert', '--from', 'agent-trace', resolve(FIXTURES, 'agent-trace/sample.json')], base({ out: out.sink }));
    expect(code).toBe(0);
    expect(out.text()).toContain('"kind": "agent-trace-v1"');
  });

  it('detect exits 0 on a clean record and 1 on a headline signature', async () => {
    expect(await runCli(['detect', cleanFixture()], base())).toBe(0);
    expect(await runCli(['detect', loopFixture()], base())).toBe(1);
  });

  it('report prints a post-mortem (exit 0)', async () => {
    const out = capture();
    const code = await runCli(['report', loopFixture()], base({ out: out.sink }));
    expect(code).toBe(0);
    expect(out.text()).toMatch(/run s_[0-9a-f]{8}/);
    expect(out.text()).toContain('LOOP');
  });

  it('audit exits 0 on the clean labeled fixtures', async () => {
    const code = await runCli(['audit', LABELED], base());
    expect(code).toBe(0);
  });

  it('ingest refuses without a salt (exit 1)', async () => {
    const code = await runCli(['ingest', '--dir', FIXTURES], base({ env: {} }));
    expect(code).toBe(1);
  });

  it('an unknown command exits 2', async () => {
    expect(await runCli(['frobnicate'], base())).toBe(2);
    expect(await runCli([], base())).toBe(2);
  });

  it('runs the full ingest -> analyze -> headline -> repro pipeline (exit 0, real numbers)', async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'af-cli-'));
    try {
      const raw = resolve(tmp, 'raw');
      mkdirSync(raw, { recursive: true });
      const clean = sess('sess-clean').prompt('x').toolUse('a', 'Read', { file: 'f' }).result('a', 'ok').llm('done').lines_();
      const loop = sess('sess-loop').prompt('x').toolUse('a', 'Bash', { command: 's' }).result('a', 'same').toolUse('b', 'Bash', { command: 's' }).result('b', 'same').toolUse('c', 'Bash', { command: 's' }).result('c', 'same').llm('stuck').lines_();
      const empty = [JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-10T10:00:00.000Z', sessionId: 'sess-empty', message: { role: 'user', content: 'a prompt with no assistant reply' } })];
      writeFileSync(resolve(raw, 'clean.jsonl'), clean.join('\n'));
      writeFileSync(resolve(raw, 'loop.jsonl'), loop.join('\n'));
      writeFileSync(resolve(raw, 'empty.jsonl'), empty.join('\n'));

      const env = { PB_ANON_SALT: SALT };
      const ctx = base({ cwd: tmp, env });
      expect(await runCli(['ingest', '--dir', 'raw', '--out', 'data/records'], ctx)).toBe(0);
      const recs = readdirSync(resolve(tmp, 'data/records'));
      expect(recs).toHaveLength(2); // empty.jsonl (zero-assistant) excluded

      expect(await runCli(['analyze'], ctx)).toBe(0);
      expect(existsSync(resolve(tmp, 'data/run-meta.json'))).toBe(true);

      const hl = capture();
      expect(await runCli(['headline'], base({ cwd: tmp, env, out: hl.sink }))).toBe(0);
      expect(hl.text()).toContain('Across 2 of my own Claude Code sessions');
      expect(hl.text()).not.toMatch(/\{[a-z_]+\}/);

      expect(await runCli(['repro'], ctx)).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
