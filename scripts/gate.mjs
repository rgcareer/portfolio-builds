#!/usr/bin/env node
// The done-gate. Runs every required check registered in tests.json (optionally filtered
// by piece or check id), records exit code + parsed test counts + output tail into
// evidence/gate-<timestamp>.json (and evidence/latest.json), and exits non-zero if any
// required check failed. tests.json is append-only; this script is the ONLY writer of
// evidence files.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(resolve(ROOT, 'tests.json'), 'utf8'));
const filters = process.argv.slice(2);
const checks = registry.checks.filter(
  (c) => filters.length === 0 || filters.includes(c.piece) || filters.includes(c.id),
);
if (checks.length === 0) {
  console.error(`gate: no checks match ${JSON.stringify(filters)}`);
  process.exit(2);
}

function parseVitest(out) {
  // Vitest summary lines: "Tests  172 passed (172)" or "Tests  1 failed | 171 passed (172)"
  const m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/.exec(out);
  if (!m) {
    const f = /Tests\s+(\d+)\s+failed\s*\((\d+)\)/.exec(out);
    if (f) return { failed: Number(f[1]), passed: 0, total: Number(f[2]) };
    return null;
  }
  return { failed: Number(m[1] ?? 0), passed: Number(m[2]), total: Number(m[3]) };
}

const startedAt = new Date().toISOString();
const results = [];
for (const c of checks) {
  const t0 = Date.now();
  const r = spawnSync(c.cmd, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const tests = c.parse === 'vitest' ? parseVitest(out) : null;
  const notes = [];
  let pass = r.status === 0;
  if (pass && c.parse === 'vitest' && !tests) {
    pass = false;
    notes.push('exit 0 but no vitest summary line found');
  }
  if (pass && c.expect && typeof c.expect.minPassed === 'number') {
    if (!tests || tests.passed < c.expect.minPassed) {
      pass = false;
      notes.push(`expected >= ${c.expect.minPassed} passed, got ${tests ? tests.passed : 'unparsed'}`);
    }
  }
  const durationMs = Date.now() - t0;
  results.push({
    id: c.id,
    piece: c.piece,
    kind: c.kind,
    required: c.required,
    cmd: c.cmd,
    exitCode: r.status,
    pass,
    durationMs,
    tests,
    notes,
    outputTail: out.split('\n').slice(-30).join('\n'),
  });
  const testStr = tests ? `  tests ${tests.passed} passed${tests.failed ? `, ${tests.failed} failed` : ''}` : '';
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.id}  (${durationMs} ms)${testStr}${notes.length ? '  ' + notes.join('; ') : ''}`);
}

const failedRequired = results.filter((r) => r.required && !r.pass);
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  node: process.version,
  filters,
  summary: { total: results.length, passed: results.filter((r) => r.pass).length, failedRequired: failedRequired.length },
  results,
};
mkdirSync(resolve(ROOT, 'evidence'), { recursive: true });
const stamp = startedAt.replace(/[:.]/g, '-');
const path = resolve(ROOT, 'evidence', `gate-${stamp}.json`);
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
writeFileSync(resolve(ROOT, 'evidence', 'latest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\ngate: ${report.summary.passed}/${report.summary.total} passed, ${failedRequired.length} required failed -> ${path.replace(ROOT + '/', '')}`);
process.exit(failedRequired.length > 0 ? 1 : 0);
