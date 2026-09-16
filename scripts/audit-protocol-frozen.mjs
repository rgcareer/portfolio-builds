#!/usr/bin/env node
// Generalized protocol-freeze audit for any package: proves the pre-registered protocol was
// committed BEFORE the data was collected and has not changed since. App-agnostic — it derives
// the freeze commit from git history rather than trusting a field the CLI may not record.
// Usage: node scripts/audit-protocol-frozen.mjs <pkg>
//
// Passes (with a note) when no run-state.json exists yet. Otherwise requires:
//   1. run-state.json records a non-empty protocolHash and a run timestamp;
//   2. the freeze commit = the last commit touching packages/<pkg>/protocol/ is an ancestor of HEAD;
//   3. the package's protocol/ files are byte-identical to their state at the freeze commit
//      (no post-freeze protocol edits, committed or working-tree);
//   4. the freeze commit's time precedes the run timestamp;
//   5. if run-state records a protocolCommit, it is consistent (ancestor of the freeze commit,
//      or the freeze commit itself).
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

const TS_FIELDS = ['seededAt', 'ranAt', 'ingestedAt', 'embeddedAt', 'snapshottedAt', 'extractedAt', 'generatedAt', 'fetchedAt', 'frozenAt', 'lastScanAt', 'analyzedAt'];

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
const runTs = TS_FIELDS.map((f) => state[f]).find((v) => typeof v === 'string');
if (!runTs) problems.push(`run-state.json has no run timestamp (one of ${TS_FIELDS.join('/')})`);

// Freeze commit = last commit that touched this package's protocol/ directory.
let freeze = '';
try {
  freeze = git(['log', '-1', '--format=%H', '--', relProto]).trim();
} catch (e) {
  problems.push(`git log for ${relProto} failed: ${e.message}`);
}
if (!freeze) {
  problems.push(`no commit has touched ${relProto} yet (protocol not committed = not frozen)`);
} else {
  try {
    git(['merge-base', '--is-ancestor', freeze, 'HEAD'], { stdio: 'ignore' });
  } catch {
    problems.push(`freeze commit ${freeze.slice(0, 10)} is not an ancestor of HEAD`);
  }
  // Protocol files must be byte-identical to their state at the freeze commit (working tree included).
  try {
    git(['diff', '--quiet', freeze, '--', relProto], { stdio: 'ignore' });
  } catch {
    problems.push(`protocol/ changed since the freeze commit ${freeze.slice(0, 10)} (a protocol edit after freezing)`);
  }
  // Freeze commit time must precede the run timestamp.
  if (runTs) {
    try {
      const committedAt = git(['show', '-s', '--format=%cI', freeze]).trim();
      if (new Date(committedAt).getTime() > new Date(runTs).getTime()) {
        problems.push(`freeze commit time ${committedAt} is AFTER the run timestamp ${runTs}`);
      }
    } catch (e) {
      problems.push(`git inspection of ${freeze} failed: ${e.message}`);
    }
  }
  // Defense in depth: if the CLI recorded a protocolCommit, it must be consistent with the freeze.
  if (state.protocolCommit && typeof state.protocolCommit === 'string') {
    try {
      git(['merge-base', '--is-ancestor', state.protocolCommit, 'HEAD'], { stdio: 'ignore' });
      git(['diff', '--quiet', state.protocolCommit, '--', relProto], { stdio: 'ignore' });
    } catch {
      problems.push(`recorded protocolCommit ${String(state.protocolCommit).slice(0, 10)} is not an ancestor of HEAD with unchanged protocol`);
    }
  }
}

if (problems.length) {
  console.error(`protocol-frozen[${pkg}]: FAIL\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`protocol-frozen[${pkg}]: OK — protocol frozen at ${freeze.slice(0, 10)} before the run (${runTs}), unchanged since`);
