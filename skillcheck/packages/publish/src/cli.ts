import { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDbPath } from '@skillcheck/core';
import { buildArtifacts, PublishError } from './serialize';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The responsible-disclosure page MUST exist before any findings data is written. */
export function disclosurePageExists(siteDir: string): boolean {
  return ['disclosure.astro', 'disclosure.md', 'disclosure/index.astro'].some((p) =>
    existsSync(join(siteDir, 'src', 'pages', p)),
  );
}

interface PublishOptions {
  db?: string;
  site?: string;
  allowNoDisclosurePage?: boolean;
}

function run(opts: PublishOptions): void {
  const db = openDb(resolveDbPath(opts.db));
  const siteDir = opts.site ? resolve(opts.site) : resolve(REPO_ROOT, 'site');

  if (!opts.allowNoDisclosurePage && !disclosurePageExists(siteDir)) {
    process.stderr.write(
      `Refusing to publish findings: no /disclosure page found under ${join(siteDir, 'src', 'pages')}.\n` +
        `The responsible-disclosure policy must be live before any finding data is emitted.\n`,
    );
    process.exitCode = 2;
    return;
  }

  let artifacts;
  try {
    artifacts = buildArtifacts(db);
  } catch (e) {
    if (e instanceof PublishError) {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  const dataDir = join(siteDir, 'src', 'data');
  const publicDir = join(siteDir, 'public', 'data');
  for (const dir of [dataDir, publicDir]) mkdirSync(dir, { recursive: true });
  for (const dir of [dataDir, publicDir]) {
    writeFileSync(join(dir, 'skills.json'), artifacts.skillsJson);
    writeFileSync(join(dir, 'findings.json'), artifacts.findingsJson);
    writeFileSync(join(dir, 'run-meta.json'), artifacts.runMetaJson);
  }
  process.stdout.write(`Published to ${dataDir} (and public/data mirror).\n`);
}

const program = new Command();
program
  .name('publish')
  .description('SQLite → site JSON with structural disclosure redaction (M1).')
  .option('--db <path>', 'SQLite database path')
  .option('--site <dir>', 'site directory (default: ./site)')
  .option('--allow-no-disclosure-page', 'skip the disclosure-page preflight (build sequencing only)')
  .action((opts: PublishOptions) => run(opts));

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exitCode = 1;
});
