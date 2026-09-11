#!/usr/bin/env node
// Audit: nothing committed under the Onboarding Transfer Rate data dir carries a secret,
// and nothing WE generated carries personal data. Corpus pages are public vendor content
// (their own contact addresses are theirs to publish), so for raw/text pages only key and
// token shapes are checked; for generated files (seed, candidates, ledger, cache, findings,
// run-meta) emails, phones, and LinkedIn slugs are checked too.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'packages', 'onboarding-transfer-rate', 'data');

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

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!existsSync(DATA)) {
  console.log('pii-sweep: no data dir yet (nothing to sweep)');
  process.exit(0);
}
const files = walk(DATA);
const hits = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  const isCorpusPage = /\/corpus\/[^/]+\/(?:raw\.(?:html|md)|text\.txt)$/.test(rel);
  const text = readFileSync(f, 'utf8');
  const rules = isCorpusPage ? SECRETS : [...SECRETS, ...PERSONAL];
  for (const [kind, re] of rules) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) hits.push(`${rel}: ${kind} at ${m.index}`);
  }
}
if (hits.length) {
  console.error(`pii-sweep: FAIL (${hits.length})\n  ` + hits.slice(0, 20).join('\n  '));
  process.exit(1);
}
console.log(`pii-sweep: OK — ${files.length} files under packages/onboarding-transfer-rate/data are clean`);
