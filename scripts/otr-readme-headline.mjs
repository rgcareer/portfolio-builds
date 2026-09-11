#!/usr/bin/env node
// Audit: the README's Result section carries exactly the sentence the generator renders from
// run-meta.json (no hand-typed number can drift). Passes with a note while no run exists AND
// the README still says "Not yet measured"; fails if one exists without the other.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = resolve(ROOT, 'packages', 'onboarding-transfer-rate');
const readme = readFileSync(resolve(PKG, 'README.md'), 'utf8');
const hasRun = existsSync(resolve(PKG, 'data', 'run-meta.json'));
const saysUnmeasured = /## Result\s+Not yet measured\./.test(readme);

if (!hasRun) {
  if (saysUnmeasured) {
    console.log('readme-headline: no run yet and README says "Not yet measured" (consistent)');
    process.exit(0);
  }
  console.error('readme-headline: FAIL — README claims a result but no run-meta.json exists');
  process.exit(1);
}
let sentence;
try {
  sentence = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'headline'], { cwd: PKG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch (e) {
  console.error(`readme-headline: FAIL — headline generator refused: ${e.message}`);
  process.exit(1);
}
if (saysUnmeasured) {
  console.error('readme-headline: FAIL — run exists but README still says "Not yet measured"');
  process.exit(1);
}
if (!readme.includes(sentence)) {
  console.error(`readme-headline: FAIL — README does not contain the generated sentence verbatim:\n  ${sentence}`);
  process.exit(1);
}
console.log('readme-headline: OK — README carries the generated sentence verbatim');
