#!/usr/bin/env node
// Generalized PII/secret sweep for any package's committed data + fixtures.
// Usage: node scripts/audit-pii-sweep.mjs <pkg>
//
// Secret shapes are checked in EVERY committed file. Personal-data shapes (email, phone,
// LinkedIn) are also checked, EXCEPT in snapshots of public external docs (docmend's
// data/corpus/<id>/raw.*|text.txt, OTR-style), where the vendor's own contact details are
// theirs to publish — there only secrets are checked. Everything the tools GENERATE
// (findings, run-meta, records, curves, ledgers) is held to the full set.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = process.argv[2];
if (!pkg) {
  console.error('usage: audit-pii-sweep.mjs <pkg>');
  process.exit(2);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = resolve(ROOT, 'packages', pkg);

const SECRETS = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['openai-key', /\bsk-[A-Za-z0-9]{32,}\b/g],
];
const PERSONAL = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['phone', /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g],
  ['linkedin', /linkedin\.com\/in\/[A-Za-z0-9_-]+/gi],
];
// Only files git actually tracks matter for "nothing committed leaks"; but sweeping the
// working tree of data/ and fixtures/ is stricter and catches a leak before it is committed.
const DIRS = ['data', 'fixtures'].map((d) => resolve(PKG, d)).filter(existsSync);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

if (DIRS.length === 0) {
  console.log(`pii-sweep[${pkg}]: no data/ or fixtures/ yet (nothing to sweep)`);
  process.exit(0);
}

const files = DIRS.flatMap((d) => walk(d));
const hits = [];
let swept = 0;
for (const f of files) {
  const rel = relative(ROOT, f);
  // Skip binary-ish files by extension; sweep text/JSON/JSONL/MD/HTML/TXT/CSV.
  if (!/\.(json|jsonl|md|markdown|txt|html?|csv|tsv|diff|patch)$/i.test(rel) && !/(^|\/)raw\.[a-z]+$/i.test(rel)) continue;
  swept++;
  const isPublicCorpusPage = /\/corpus\/[^/]+\/(?:raw\.(?:html?|md)|text\.txt)$/.test(rel);
  const text = readFileSync(f, 'utf8');
  const rules = isPublicCorpusPage ? SECRETS : [...SECRETS, ...PERSONAL];
  for (const [kind, re] of rules) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) hits.push(`${rel}: ${kind} at ${m.index} (${JSON.stringify(m[0].slice(0, 40))})`);
  }
}

if (hits.length) {
  console.error(`pii-sweep[${pkg}]: FAIL (${hits.length})\n  ` + hits.slice(0, 25).join('\n  '));
  process.exit(1);
}
console.log(`pii-sweep[${pkg}]: OK — ${swept} committed text files under data/ + fixtures/ are clean`);
