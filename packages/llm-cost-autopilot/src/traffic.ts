// Reads already-captured traffic back in: committed *.jsonl snapshots (readTraffic) and a
// live cost ledger (importLedger, real non-mock calls only). Both feed the same
// TrafficRecord shape that counterfactual.ts prices.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ledger, readTrafficJsonl, type TrafficRecord } from '@portfolio-builds/shared';

/** Every *.jsonl file in `dir`, parsed back to records. Missing directory -> []. */
export function readTraffic(dir: string): TrafficRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }
  const out: TrafficRecord[] = [];
  for (const f of files) {
    const text = readFileSync(resolve(dir, f), 'utf8');
    out.push(...readTrafficJsonl(text));
  }
  return out;
}

export interface ImportLedgerTallies {
  skippedMock: number;
  skippedError: number;
}

export interface ImportLedgerResult {
  records: TrafficRecord[];
  tallies: ImportLedgerTallies;
}

/**
 * Reads the shared Ledger's `calls` table at `dbPath`. Mock rows (mock=1) and errored rows
 * (error IS NOT NULL) are skipped and tallied, never priced. `cache_creation_tokens` has no
 * TTL split in the ledger schema, so it is attributed to the 5-minute bucket and the record
 * is tagged `ttlAssumed: '5m'` so downstream reporting can disclose the assumption.
 */
export function importLedger(dbPath: string): ImportLedgerResult {
  const ledger = new Ledger(dbPath);
  const tallies: ImportLedgerTallies = { skippedMock: 0, skippedError: 0 };
  const records: TrafficRecord[] = [];
  try {
    for (const row of ledger.rows()) {
      if (row.mock === 1) {
        tallies.skippedMock++;
        continue;
      }
      if (row.error !== null) {
        tallies.skippedError++;
        continue;
      }
      records.push({
        v: 1,
        id: row.id,
        ts: row.created_at,
        source: 'ledger',
        provider: row.provider,
        model: row.model,
        purpose: row.purpose,
        runId: row.run_id,
        tenant: null,
        tags: { ttlAssumed: '5m' },
        latencyTolerant: false,
        session: null,
        sidechain: false,
        systemSha256: null,
        systemChars: null,
        userSha256: null,
        userChars: null,
        usage: {
          input: row.input_tokens,
          cacheRead: row.cache_read_tokens,
          cacheCreation5m: row.cache_creation_tokens,
          cacheCreation1h: 0,
          output: row.output_tokens,
        },
        mock: false,
        error: null,
        cache: null,
      });
    }
  } finally {
    ledger.close();
  }
  return { records, tallies };
}

/**
 * Keeps records whose date (the first 10 chars of `ts`) falls within [from, to] inclusive.
 * `from`/`to` may be plain dates ("2026-08-16") or full ISO timestamps — only the date
 * portion is compared, so a date-only boundary is inclusive of the whole day.
 */
export function filterWindow(records: TrafficRecord[], from: string, to: string): TrafficRecord[] {
  const dateOf = (ts: string) => ts.slice(0, 10);
  const f = dateOf(from);
  const t = dateOf(to);
  return records.filter((r) => {
    const d = dateOf(r.ts);
    return d >= f && d <= t;
  });
}
