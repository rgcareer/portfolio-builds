#!/usr/bin/env node
// Generalized README-headline audit: the README's Result section must carry exactly the
// sentence the package's own generator renders from run-meta.json, so no hand-typed number
// can drift. Usage: node scripts/audit-readme-headline.mjs <pkg>
//
// Passes with a note while no run exists AND the README still says "Not yet measured";
// fails if one exists without the other, or if the README omits the generated sentence.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = process.argv[2];
if (!pkg) {
  console.error('usage: audit-readme-headline.mjs <pkg>');
  process.exit(2);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = resolve(ROOT, 'packages', pkg);
const README = resolve(PKG, 'README.md');
const RUNMETA = resolve(PKG, 'data', 'run-meta.json');

if (!existsSync(README)) {
  console.log(`readme-headline[${pkg}]: no README.md yet (nothing to audit)`);
  process.exit(0);
}
const readme = readFileSync(README, 'utf8');
const hasRun = existsSync(RUNMETA);
const saysUnmeasured = /##\s*Result\s+Not yet measured\./.test(readme);

if (!hasRun) {
  if (saysUnmeasured) {
    console.log(`readme-headline[${pkg}]: no run yet and README says "Not yet measured" (consistent)`);
    process.exit(0);
  }
  console.error(`readme-headline[${pkg}]: FAIL — README claims a result but no data/run-meta.json exists`);
  process.exit(1);
}

let sentence;
try {
  sentence = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'headline'], {
    cwd: PKG,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch (e) {
  console.error(`readme-headline[${pkg}]: FAIL — headline generator refused: ${e.message}`);
  process.exit(1);
}
if (saysUnmeasured) {
  console.error(`readme-headline[${pkg}]: FAIL — a run exists but README still says "Not yet measured"`);
  process.exit(1);
}
// The generator may print a bare sentence or a JSON line; accept either as long as the
// human sentence appears verbatim in the README.
const candidate = sentence.startsWith('{') ? (JSON.parse(sentence).headline ?? sentence) : sentence;
if (!candidate || !readme.includes(candidate)) {
  console.error(`readme-headline[${pkg}]: FAIL — README does not contain the generated sentence verbatim:\n  ${candidate}`);
  process.exit(1);
}
console.log(`readme-headline[${pkg}]: OK — README carries the generated sentence verbatim`);
