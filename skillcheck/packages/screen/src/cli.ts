import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stableStringify, openDb, resolveDbPath, pct, type Db } from '@skillcheck/core';
import { loadRuleset, RulesetError } from './rulesSchema';
import {
  screenSkills,
  loadSkillInputsFromCorpus,
  loadSkillInputsFromDb,
  writeScreenToDb,
  type ScreenExport,
} from './screen';

const DEFAULT_RULES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function latestHarvestSnapshot(db: Db): string | null {
  const row = db
    .prepare("SELECT snapshot_date FROM runs WHERE kind='harvest' AND status='complete' ORDER BY started_at DESC LIMIT 1")
    .get() as { snapshot_date: string | null } | undefined;
  return row?.snapshot_date ?? null;
}

function printSummary(exp: ScreenExport): void {
  const h = exp.meta.headline;
  const line = (label: string, s: { numerator: number; denominator: number }) =>
    `  ${label.padEnd(12)} ${s.numerator}/${s.denominator} (${pct(s.numerator, s.denominator)}%)`;
  process.stdout.write(
    [
      `Screened ${exp.meta.gradedCount} skills (cohort ${exp.meta.cohortSize}, invalid ${exp.meta.invalidCount})` +
        (exp.meta.sampleN === null ? '' : ` — sample ${exp.meta.sampleN}, seed ${exp.meta.seed}`),
      line('injection', h.injection),
      line('abandoned', h.abandoned),
      line('unicode', h.unicode),
      line('critical', h.critical),
      `  cohort_hash  ${exp.meta.cohortHash.slice(0, 16)}…  ruleset_hash ${exp.meta.rulesetHash.slice(0, 16)}…`,
      '',
    ].join('\n'),
  );
}

interface ScreenOptions {
  corpus?: string;
  db?: string;
  mirror?: string;
  rules?: string;
  sample?: number;
  seed?: number;
  out?: string;
  write?: boolean;
}

async function run(opts: ScreenOptions): Promise<void> {
  const rulesDir = opts.rules ? resolve(opts.rules) : DEFAULT_RULES;
  let ruleset;
  try {
    ruleset = loadRuleset(rulesDir);
  } catch (e) {
    if (e instanceof RulesetError) {
      process.stderr.write(`Invalid ruleset: ${e.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  const sampleN = opts.sample ?? null;
  const seed = opts.seed ?? 0;

  let exp: ScreenExport;

  if (opts.corpus) {
    const inputs = loadSkillInputsFromCorpus(resolve(opts.corpus));
    exp = screenSkills(inputs, ruleset, { seed, sampleN });
  } else {
    const db = openDb(resolveDbPath(opts.db));
    const snapshot = latestHarvestSnapshot(db);
    if (!snapshot) {
      process.stderr.write('No completed harvest run found — run `harvest` first (or use --corpus).\n');
      process.exitCode = 2;
      return;
    }
    const mirrorRoot = opts.mirror ? resolve(opts.mirror) : resolve(process.cwd(), 'data', 'mirror');
    const inputs = loadSkillInputsFromDb(db, mirrorRoot, snapshot);
    exp = screenSkills(inputs, ruleset, { seed, sampleN });

    if (opts.write !== false) {
      const runId = 'run_screen_' + randomUUID();
      db.prepare(
        `INSERT INTO runs (id, kind, status, snapshot_date, seed, sample_n, cohort_hash, ruleset_hash, code_version, node_version, params_json)
         VALUES (?, 'screen', 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        snapshot,
        sampleN === null ? null : seed,
        sampleN,
        exp.meta.cohortHash,
        exp.meta.rulesetHash,
        gitHead(),
        process.version,
        JSON.stringify({ sample: sampleN, seed, rulesDir }),
      );
      writeScreenToDb(db, runId, exp);
      db.prepare("UPDATE runs SET status='complete', finished_at=datetime('now') WHERE id=?").run(runId);
      process.stderr.write(`Wrote screen run ${runId} to the database.\n`);
    }
  }

  if (opts.out) {
    writeFileSync(resolve(opts.out), stableStringify(exp));
    process.stderr.write(`Wrote canonical export to ${resolve(opts.out)}\n`);
  }

  printSummary(exp);
}

const program = new Command();
program
  .name('screen')
  .description('Static-analysis screen of the skill cohort (M1: The Scan).')
  .option('--corpus <dir>', 'screen a fixture corpus directory instead of the DB')
  .option('--db <path>', 'SQLite database path')
  .option('--mirror <dir>', 'mirror root for skill files (real mode)')
  .option('--rules <dir>', 'rule-pack directory')
  .option('--sample <n>', 'sample size (omit to screen the full cohort)', (v) => parseInt(v, 10))
  .option('--seed <n>', 'PRNG seed for sampling', (v) => parseInt(v, 10))
  .option('--out <file>', 'write the canonical export JSON here')
  .option('--no-write', 'do not persist results to the DB (real mode)')
  .action((opts: ScreenOptions) => run(opts));

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exitCode = 1;
});
