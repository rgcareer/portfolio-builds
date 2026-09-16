import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli, type CliPaths } from '../src/cli';
import { loadProtocol } from '../src/protocol';

const proto = loadProtocol();

function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

describe('repro', () => {
  let dir: string;
  let paths: CliPaths;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'mr-repro-'));
    paths = { dataDir: resolve(dir, 'data'), goldenPath: resolve(dir, 'golden', 'golden-v1.json') };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes as a no-op before any run exists', async () => {
    const c = collector();
    const code = await runCli(['repro', '--json'], { io: c.io, paths, protocol: proto });
    expect(code).toBe(0);
    expect(JSON.parse(c.out.join('')).repro).toBe('noop');
  });

  it('re-derives comparison.json + run-meta.json bit-for-bit after a mock run', async () => {
    for (const cond of ['A', 'B', 'A-repeat']) {
      await runCli(['run', '--condition', cond, '--mock'], { io: collector().io, paths, protocol: proto });
    }
    await runCli(['compare'], { io: collector().io, paths, protocol: proto });

    const c = collector();
    const code = await runCli(['repro', '--json'], { io: c.io, paths, protocol: proto });
    expect(code).toBe(0);
    const payload = JSON.parse(c.out.join(''));
    expect(payload.repro).toBe('ok');
    expect(payload.comparison).toBe(true);
    expect(payload.runMeta).toBe(true);
  });
});
