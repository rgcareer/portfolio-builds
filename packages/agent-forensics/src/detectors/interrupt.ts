import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// INTERRUPT (secondary): a tool call interrupted mid-flight.
export function detectInterrupt(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'INTERRUPT');
  const out: Signature[] = [];
  for (const c of record.toolCalls) {
    if (!c.interrupted) continue;
    out.push({
      detector: 'INTERRUPT',
      severity: def.severity,
      turnStart: c.callTurn,
      turnEnd: c.resultTurn ?? c.callTurn,
      toolCallIds: [c.id],
      evidence: { name: c.name },
    });
  }
  return out;
}
