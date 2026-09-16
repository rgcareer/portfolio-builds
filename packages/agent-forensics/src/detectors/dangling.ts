import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// DANGLE: a tool call that never received a result (and is not an orphaned result). Its
// evidence records that it dangled at session end.
export function detectDangling(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'DANGLE');
  const out: Signature[] = [];
  for (const c of record.toolCalls) {
    if (c.resultTurn !== null || c.orphan) continue;
    out.push({
      detector: 'DANGLE',
      severity: def.severity,
      turnStart: c.callTurn,
      turnEnd: c.callTurn,
      toolCallIds: [c.id],
      evidence: { name: c.name, atSessionEnd: true },
    });
  }
  return out;
}
