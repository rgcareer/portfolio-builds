#!/usr/bin/env node
// Deterministic redaction of personal identifiers in the files THIS pipeline generates for the
// Onboarding Transfer Rate piece: seed snapshots, candidates, exclusion ledger, and per-page
// manifests. Personal-profile URLs (linkedin.com/in/...) and email-shaped strings become fixed
// tokens; organisation pages (linkedin.com/company/...) are left alone. Raw and text pages are
// public vendor content and are never touched. Idempotent: running twice changes nothing.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'packages', 'onboarding-transfer-rate', 'data');

export const PROFILE_RE = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/g;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redactString(s) {
  return s.replace(PROFILE_RE, '[redacted:profile-url]').replace(EMAIL_RE, '[redacted:email]');
}

function walk(v) {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = walk(v[k]);
    return o;
  }
  return v;
}

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

const targets = [];
for (const f of ['candidates.json', 'exclusion-ledger.json']) if (existsSync(resolve(DATA, f))) targets.push(resolve(DATA, f));
if (existsSync(resolve(DATA, 'seed'))) for (const f of readdirSync(resolve(DATA, 'seed'))) if (f.endsWith('.json')) targets.push(resolve(DATA, 'seed', f));
if (existsSync(resolve(DATA, 'corpus'))) for (const d of readdirSync(resolve(DATA, 'corpus'))) {
  const m = resolve(DATA, 'corpus', d, 'manifest.json');
  if (existsSync(m)) targets.push(m);
}

let changed = 0;
for (const p of targets) {
  const before = readFileSync(p, 'utf8');
  const after = stable(walk(JSON.parse(before)));
  if (after !== before) {
    writeFileSync(p, after);
    changed++;
    console.log(`redacted: ${p.replace(ROOT + '/', '')}`);
  }
}
console.log(`redact-generated: ${targets.length} files scanned, ${changed} changed`);
