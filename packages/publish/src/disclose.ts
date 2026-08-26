import { Command } from 'commander';
import { openDb, resolveDbPath, type Db } from '@skillcheck/core';

// Responsible-disclosure state machine (operational — not part of the deterministic publish
// output, so wall-clock use here is fine). Release is a HUMAN command and refuses before the
// 14-day due date; the due date is a floor, never an auto-trigger.

const NOTICE_DAYS = 14;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

function notify(db: Db, skillId: string): void {
  const now = new Date().toISOString();
  const due = addDays(now, NOTICE_DAYS);
  const info = db
    .prepare("UPDATE disclosures SET status='notified', notified_at=?, disclosure_due_at=? WHERE skill_id=?")
    .run(now, due, skillId);
  process.stdout.write(
    info.changes > 0
      ? `Notified ${skillId}; disclosure window closes ${due}.\n`
      : `No disclosures row for ${skillId} (is it a gated skill?).\n`,
  );
}

function release(db: Db, skillId: string): void {
  const row = db.prepare('SELECT status, disclosure_due_at FROM disclosures WHERE skill_id=?').get(skillId) as
    | { status: string; disclosure_due_at: string | null }
    | undefined;
  if (!row) {
    process.stderr.write(`No disclosures row for ${skillId}.\n`);
    process.exitCode = 2;
    return;
  }
  if (!row.disclosure_due_at || Date.now() < Date.parse(row.disclosure_due_at)) {
    process.stderr.write(
      `Refusing to release ${skillId}: the ${NOTICE_DAYS}-day notice window has not elapsed ` +
        `(due ${row.disclosure_due_at ?? 'never — not notified'}).\n`,
    );
    process.exitCode = 2;
    return;
  }
  db.prepare("UPDATE disclosures SET status='disclosed' WHERE skill_id=?").run(skillId);
  process.stdout.write(`Released ${skillId}; it will be named on the next publish.\n`);
}

function withdraw(db: Db, skillId: string, note?: string): void {
  db.prepare("UPDATE disclosures SET status='withdrawn', notes=? WHERE skill_id=?").run(note ?? null, skillId);
  process.stdout.write(`Withdrew ${skillId} (finding treated as a false positive).\n`);
}

function list(db: Db): void {
  const rows = db.prepare('SELECT skill_id, status, placeholder_id, disclosure_due_at FROM disclosures ORDER BY skill_id').all();
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

const program = new Command();
program.name('disclose').description('Responsible-disclosure state machine.').option('--db <path>', 'SQLite database path');
program.command('notify <skillId>').action((skillId: string) => notify(openDb(resolveDbPath(program.opts().db)), skillId));
program.command('release <skillId>').action((skillId: string) => release(openDb(resolveDbPath(program.opts().db)), skillId));
program
  .command('withdraw <skillId>')
  .option('-m, --note <text>')
  .action((skillId: string, opts: { note?: string }) => withdraw(openDb(resolveDbPath(program.opts().db)), skillId, opts.note));
program.command('list').action(() => list(openDb(resolveDbPath(program.opts().db))));

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exitCode = 1;
});
