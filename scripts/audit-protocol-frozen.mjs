#!/usr/bin/env node
// Generalized protocol-freeze audit for any package: proves the pre-registered protocol was
// committed BEFORE the data was collected and has not changed since. App-agnostic — it does
// not need the package's internal hash recipe. Usage: node scripts/audit-protocol-frozen.mjs <pkg>
//
// Passes (with a note) when no run-state.json exists yet. Otherwise requires:
//   1. run-state.json records a non-empty protocolHash and a protocolCommit;
//   2. protocolCommit is an ancestor of HEAD;
//   3. the package's protocol/ files are byte-identical to their state at protocolCommit
//      (no post-freeze protocol edits);
//   4. protocolCommit's commit time precedes the run timestamp.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = process.argv[2];
if (!pkg) {
  console.error('usage: audit-protocol-frozen.mjs <pkg>');
  process.exit(2);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = resolve(ROOT, 'packages', pkg);
const PROTO = resolve(PKG, 'protocol');
const STATE = resolve(PKG, 'data', 'run-state.json');
const relProto = `packages/${pkg}/protocol`;

const TS_FIELDS = ['seededAt', 'ranAt', 'ingestedAt', 'embeddedAt', 'snapshottedAt', 'extractedAt', 'frozenAt', 'generatedAt'];

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

if (!existsSync(PROTO) || readdirSync(PROTO).filter((f) => f.endsWith('.json')).length === 0) {
  console.log(`protocol-frozen[${pkg}]: no protocol/*.json yet (nothing to audit)`);
  process.exit(0);
}
if (!existsSync(STATE)) {
  console.log(`protocol-frozen[${pkg}]: no run yet (run-state.json absent); protocol present (nothing to audit)`);
  process.exit(0);
}

const state = JSON.parse(readFileSync(STATE, 'utf8'));
const problems = [];
if (!state.protocolHash || typeof state.protocolHash !== 'string') problems.push('run-state.json has no protocolHash');
if (!state.protocolCommit || typeof state.protocolCommit !== 'string') problems.push('run-state.json has no protocolCommit');

const runTs = TS_FIELDS.map((f) => state[f]).find((v) => typeof v === 'string');
if (!runTs) problems.push(`run-state.json has no run timestamp (one of ${TS_FIELDS.join('/')})`);

if (state.protocolCommit) {
  try {
    git(['merge-base', '--is-ancestor', state.protocolCommit, 'HEAD'], { stdio: 'ignore' });
  } catch {
    problems.push(`protocolCommit ${state.protocolCommit} is not an ancestor of HEAD`);
  }
  // Protocol files must be byte-identical to their state at the freeze commit.
  try {
    git(['diff', '--quiet', state.protocolCommit, '--', relProto], { stdio: 'ignore' });
  } catch {
    problems.push(`protocol/ changed since the freeze commit ${String(state.protocolCommit).slice(0, 10)} (a protocol edit after freezing)`);
  }
  // Freeze commit time must precede the run timestamp.
  if (runTs) {
    try {
      const committedAt = git(['show', '-s', '--format=%cI', state.protocolCommit]).trim();
      if (new Date(committedAt).getTime() > new Date(runTs).getTime()) {
        problems.push(`freeze commit time ${committedAt} is AFTER the run timestamp ${runTs}`);
      }
    } catch (e) {
      problems.push(`git inspection of ${state.protocolCommit} failed: ${e.message}`);
    }
  }
}

if (problems.length) {
  console.error(`protocol-frozen[${pkg}]: FAIL\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`protocol-frozen[${pkg}]: OK — protocol frozen at ${String(state.protocolCommit).slice(0, 10)} before the run (${runTs}), unchanged since`);
