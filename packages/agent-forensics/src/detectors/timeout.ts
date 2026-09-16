import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// TIMEOUT: a tool call that timed out (timedOut flag or error-class timeout).
export function detectTimeout(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'TIMEOUT');
  const out: Signature[] = [];
  for (const c of record.toolCalls) {
    if (!c.timedOut && c.errorClass !== 'timeout') continue;
    out.push({
      detector: 'TIMEOUT',
      severity: def.severity,
      turnStart: c.callTurn,
      turnEnd: c.resultTurn ?? c.callTurn,
      toolCallIds: [c.id],
      evidence: { name: c.name, errorClass: c.errorClass },
    });
  }
  return out;
}
