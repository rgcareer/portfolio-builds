#!/usr/bin/env node
// Renders the root README's "Results" list from each package's own headline generator —
// the same `src/cli.ts headline` output the per-package readme-headline audits verify
// against data/run-meta.json. The root README never carries a hand-typed number.
//
// Usage:
//   node scripts/render-root-results.mjs            # rewrite the section in README.md
//   node scripts/render-root-results.mjs --check    # exit 1 if README differs from a fresh render
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = resolve(ROOT, 'README.md');
const BEGIN = '<!-- results:begin — rendered by scripts/render-root-results.mjs; do not edit by hand -->';
const END = '<!-- results:end -->';

// Measured packages, in the order they appear in the README's package table.
const PACKAGES = [
  'llm-cost-autopilot',
  'semantic-cache',
  'model-regress',
  'agent-forensics',
  'docmend',
  'onboarding-transfer-rate',
];

function headline(pkg) {
  const dir = resolve(ROOT, 'packages', pkg);
  if (!existsSync(resolve(dir, 'data', 'run-meta.json'))) return null;
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'headline'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const raw = out.startsWith('{') ? (JSON.parse(out).headline ?? '') : out;
  const sentence = raw.replace(/^headline:\s*/, ''); // some generators label their output
  if (!sentence) throw new Error(`headline generator for ${pkg} returned nothing`);
  return sentence;
}

// docmend's frozen headline template phrases its corpus parenthetical confusingly
// (the 12 site pages read as if nested under the 8 own-repo pages). The template is
// pre-registered protocol and stays as rendered in the package README; here we append
// a clarifying composition line whose every number comes from the committed run-meta,
// with a hard consistency assertion — never from prose.
function docmendCorpusLine() {
  const m = JSON.parse(readFileSync(resolve(ROOT, 'packages', 'docmend', 'data', 'run-meta.json'), 'utf8'));
  const { own, repos, sitePages, ext, pages } = m.corpus;
  if (own + sitePages + ext !== pages) {
    throw new Error(`docmend corpus does not sum: ${own}+${sitePages}+${ext} != ${pages}`);
  }
  return `  (Corpus composition per its run-meta: ${own} own-repo pages across ${repos} public repos + ${sitePages} getsmartai.ai pages + ${ext} external quickstarts = ${pages}.)`;
}

const lines = [];
let rendered = 0;
for (const pkg of PACKAGES) {
  const sentence = headline(pkg);
  if (sentence === null) continue; // unmeasured packages simply don't appear
  lines.push(`- **[${pkg}](packages/${pkg})** — ${sentence}`);
  if (pkg === 'docmend') lines.push(docmendCorpusLine());
  rendered++;
}
if (rendered === 0) throw new Error('no measured packages found — refusing to render an empty section');
const section = `${BEGIN}\n${lines.join('\n')}\n${END}`;

const readme = readFileSync(README, 'utf8');
const pattern = new RegExp(
  `${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
);
if (!pattern.test(readme)) {
  console.error('render-root-results: FAIL — README.md is missing the results markers');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const current = readme.match(pattern)[0];
  if (current === section) {
    console.log(`render-root-results: OK — README results match a fresh render (${rendered} packages)`);
    process.exit(0);
  }
  console.error('render-root-results: FAIL — README results differ from a fresh render. Run: node scripts/render-root-results.mjs');
  process.exit(1);
}

writeFileSync(README, readme.replace(pattern, section));
console.log(`render-root-results: wrote ${rendered} package results into README.md`);
