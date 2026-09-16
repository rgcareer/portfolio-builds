// Audit logic the main session wires into tests.json. protocol-frozen lives in protocol.ts
// (it needs the Protocol/RunState types); here are the other two:
//   - pii-sweep: no committed file under golden/ or data/ may contain PII/secrets.
//   - readme-headline: any headline sentence in the README must be the one renderHeadline
//     produces from the committed run-meta — never a hand-typed number.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { findPii, renderHeadline, type PiiHit } from '@portfolio-builds/shared';
import type { Protocol, AuditResult } from './protocol';
import type { RunMeta } from './report';

export interface PiiSweepHit {
  file: string;
  hits: PiiHit[];
}

export interface PiiSweepResult {
  ok: boolean;
  filesScanned: number;
  violations: PiiSweepHit[];
}

/** Recursively scan the given directories; every text file must be PII-free. */
export function piiSweep(dirs: string[]): PiiSweepResult {
  const violations: PiiSweepHit[] = [];
  let filesScanned = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = resolve(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      filesScanned++;
      let text: string;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const hits = findPii(text);
      if (hits.length > 0) violations.push({ file: p, hits });
    }
  };
  for (const d of dirs) walk(d);
  return { ok: violations.length === 0, filesScanned, violations };
}

/**
 * The README's headline must be exactly what renderHeadline produces from the committed
 * run-meta — proving the number came from published data, not a keyboard. Vacuously passes
 * before a paired run has produced headline values.
 */
export function readmeHeadlineAudit(readme: string, proto: Protocol, meta: RunMeta): AuditResult {
  if (!meta.headlineValues) return { ok: true, reasons: ['no run-meta headline values yet; nothing to verify'] };
  const rendered = renderHeadline(proto.experiment.headline_template, meta.headlineValues);
  if (!readme.includes(rendered)) {
    return { ok: false, reasons: ['README does not contain the run-meta-rendered headline verbatim (a number may have been hand-typed)'] };
  }
  return { ok: true, reasons: [] };
}
