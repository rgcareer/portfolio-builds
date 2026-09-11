#!/usr/bin/env node
// Audit: the Onboarding Transfer Rate protocol was frozen BEFORE the data was fetched.
// (1) the hash recorded at seed time equals the hash of the committed protocol files now;
// (2) the recorded protocol commit is an ancestor of HEAD and its commit time precedes
// seededAt. Passes trivially (with a note) before the run has been seeded.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = resolve(ROOT, 'packages', 'onboarding-transfer-rate');
const STATE = resolve(PKG, 'data', 'run-state.json');

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  return v;
}
const stable = (v) => JSON.stringify(canonicalize(v), null, 2) + '\n';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const corpusRule = JSON.parse(readFileSync(resolve(PKG, 'protocol', 'corpus-rule.json'), 'utf8'));
const checks = JSON.parse(readFileSync(resolve(PKG, 'protocol', 'checks.json'), 'utf8'));
const nowHash = sha(stable({ corpusRule, checks }));

if (!existsSync(STATE)) {
  console.log(`protocol-frozen: not seeded yet; current protocol hash ${nowHash.slice(0, 16)}… (nothing to audit)`);
  process.exit(0);
}
const state = JSON.parse(readFileSync(STATE, 'utf8'));
const problems = [];
if (state.protocolHash !== nowHash) problems.push(`protocol hash changed since seeding: recorded ${state.protocolHash.slice(0, 16)}…, now ${nowHash.slice(0, 16)}…`);
if (!state.protocolCommit) problems.push('no protocolCommit recorded');
else {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', state.protocolCommit, 'HEAD'], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    problems.push(`protocol commit ${state.protocolCommit} is not an ancestor of HEAD`);
  }
  try {
    const committedAt = execFileSync('git', ['show', '-s', '--format=%cI', state.protocolCommit], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (state.seededAt && new Date(committedAt).getTime() > new Date(state.seededAt).getTime()) {
      problems.push(`protocol commit time ${committedAt} is after seededAt ${state.seededAt}`);
    }
    // The protocol files at that commit must hash to the recorded hash too.
    const cr = execFileSync('git', ['show', `${state.protocolCommit}:packages/onboarding-transfer-rate/protocol/corpus-rule.json`], { cwd: ROOT, encoding: 'utf8' });
    const ck = execFileSync('git', ['show', `${state.protocolCommit}:packages/onboarding-transfer-rate/protocol/checks.json`], { cwd: ROOT, encoding: 'utf8' });
    const thenHash = sha(stable({ corpusRule: JSON.parse(cr), checks: JSON.parse(ck) }));
    if (thenHash !== state.protocolHash) problems.push(`protocol files at ${state.protocolCommit.slice(0, 10)} hash to ${thenHash.slice(0, 16)}…, not the recorded ${state.protocolHash.slice(0, 16)}…`);
  } catch (e) {
    problems.push(`git inspection failed: ${e.message}`);
  }
}
if (problems.length) {
  console.error('protocol-frozen: FAIL\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`protocol-frozen: OK — hash ${nowHash.slice(0, 16)}… frozen at ${state.protocolCommit.slice(0, 10)} before seededAt ${state.seededAt}`);
