import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli, type CliPaths } from '../src/cli';
import { loadProtocol } from '../src/protocol';
import { goldenHash, loadGolden } from '../src/golden';

const proto = loadProtocol();

function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

describe('cli', () => {
  let dir: string;
  let paths: CliPaths;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'mr-cli-'));
    paths = { dataDir: resolve(dir, 'data'), goldenPath: resolve(dir, 'golden', 'golden-v1.json') };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 2 on an unknown command and on no command', async () => {
    const c1 = collector();
    expect(await runCli(['frobnicate'], { io: c1.io, paths })).toBe(2);
    const c2 = collector();
    expect(await runCli([], { io: c2.io, paths })).toBe(2);
  });

  it('golden gen writes a set whose hash matches the protocol, with --json output', async () => {
    const c = collector();
    const code = await runCli(['golden', 'gen', '--json'], { io: c.io, paths, protocol: proto });
    expect(code).toBe(0);
    expect(existsSync(paths.goldenPath)).toBe(true);
    const payload = JSON.parse(c.out.join(''));
    expect(payload.hash).toBe(proto.goldenHash);
    const set = loadGolden(paths.goldenPath, { expectedHash: proto.goldenHash });
    expect(goldenHash(set)).toBe(proto.goldenHash);
  });

  it('estimate --all --json returns totals under the cap', async () => {
    const c = collector();
    const code = await runCli(['estimate', '--all', '--json'], { io: c.io, paths, protocol: proto });
    expect(code).toBe(0);
    const payload = JSON.parse(c.out.join(''));
    expect(payload.rows).toHaveLength(3);
    expect(payload.totals.calls).toBe(120);
    expect(payload.totals.ceilingUsd).toBeLessThan(payload.cap_usd);
  });

  it('power --json computes an MDE and required-n table', async () => {
    const c = collector();
    const code = await runCli(['power', '--n', '40', '--discordant', '0.2', '--json'], { io: c.io, paths });
    expect(code).toBe(0);
    const payload = JSON.parse(c.out.join(''));
    expect(payload.mdePp).toBeCloseTo(19.81, 1);
    expect(payload.requiredN).toHaveLength(3);
  });

  it('runs the full mock pipeline offline: run x3 -> compare -> headline -> ci -> repro', async () => {
    for (const cond of ['A', 'B', 'A-repeat']) {
      const c = collector();
      const code = await runCli(['run', '--condition', cond, '--mock', '--json'], { io: c.io, paths, protocol: proto });
      expect(code).toBe(0);
      const payload = JSON.parse(c.out.join(''));
      expect(payload.completed).toBe(40);
      expect(payload.k).toBe(40); // perfect mock passes every item
      expect(payload.totalCostUsd).toBe(0);
    }

    const cmp = collector();
    expect(await runCli(['compare', '--json'], { io: cmp.io, paths, protocol: proto })).toBe(0);
    expect(existsSync(resolve(paths.dataDir, 'comparison.json'))).toBe(true);
    expect(existsSync(resolve(paths.dataDir, 'run-meta.json'))).toBe(true);

    const hl = collector();
    expect(await runCli(['headline'], { io: hl.io, paths, protocol: proto })).toBe(0);
    const sentence = hl.out.join('');
    expect(sentence).toContain('claude-sonnet-5 passed 40/40');
    expect(sentence).toContain('claude-haiku-4-5 passed 40/40');

    const ci = collector();
    // Both perfect => identical => no regression => exit 0.
    expect(await runCli(['ci', '--json'], { io: ci.io, paths, protocol: proto })).toBe(0);
    expect(JSON.parse(ci.out.join('')).verdict).toBe('no-detectable-regression');

    const rp = collector();
    expect(await runCli(['repro', '--json'], { io: rp.io, paths, protocol: proto })).toBe(0);
    expect(JSON.parse(rp.out.join('')).repro).toBe('ok');
  });
});
