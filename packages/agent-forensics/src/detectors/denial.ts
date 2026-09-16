import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// DENIAL (secondary): a tool call denied by permission gating.
export function detectDenial(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'DENIAL');
  const out: Signature[] = [];
  for (const c of record.toolCalls) {
    if (!c.denied) continue;
    out.push({
      detector: 'DENIAL',
      severity: def.severity,
      turnStart: c.callTurn,
      turnEnd: c.resultTurn ?? c.callTurn,
      toolCallIds: [c.id],
      evidence: { name: c.name },
    });
  }
  return out;
}
