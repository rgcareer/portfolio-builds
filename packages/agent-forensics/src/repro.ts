// Offline reproduction: re-derive findings.json + run-meta.json from the committed records
// and diff bit-for-bit against the committed files (generatedAt excluded). No network, no
// LLM. This is the logic the `repro` gate check runs.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableStringify } from '@portfolio-builds/shared';
import type { Protocol } from './protocol';
import { analyzeRecords, readRecords } from './analyze';

export interface ReproResult {
  ok: boolean;
  sessions: number;
  diff: string | null;
}

const stripGeneratedAt = (s: string): string => s.replace(/"generatedAt": "[^"]+"/g, '"generatedAt": "<ignored>"');

export function reproduce(dataDir: string, protocol: Protocol): ReproResult {
  const records = readRecords(resolve(dataDir, 'records'));
  if (records.length === 0) return { ok: false, sessions: 0, diff: 'no committed records to reproduce from' };
  const statePath = resolve(dataDir, 'run-state.json');
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { protocolCommit: string | null; ingestedAt: string | null }) : { protocolCommit: null, ingestedAt: null };
  const ledgerPath = resolve(dataDir, 'ingest-ledger.json');
  const ledger = existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { totalFiles?: number; excludedZeroAssistant?: number }) : null;
  const { findings, runMeta } = analyzeRecords(records, protocol, {
    protocolCommit: state.protocolCommit,
    ingestedAt: state.ingestedAt,
    totalFiles: ledger?.totalFiles ?? records.length,
    excludedZeroAssistant: ledger?.excludedZeroAssistant ?? 0,
  });

  const committedFindings = readFileSync(resolve(dataDir, 'findings.json'), 'utf8');
  const committedMeta = readFileSync(resolve(dataDir, 'run-meta.json'), 'utf8');
  const sameFindings = stripGeneratedAt(committedFindings) === stripGeneratedAt(stableStringify(findings));
  const sameMeta = stripGeneratedAt(committedMeta) === stripGeneratedAt(stableStringify(runMeta));
  if (sameFindings && sameMeta) return { ok: true, sessions: records.length, diff: null };
  const which = [!sameFindings ? 'findings.json' : null, !sameMeta ? 'run-meta.json' : null].filter(Boolean).join(' + ');
  return { ok: false, sessions: records.length, diff: `${which} differ from committed` };
}
