import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// HOOKERR: a record carried a non-empty hookErrors array (surfaced as a hook_error event).
export function detectHookError(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'HOOKERR');
  const out: Signature[] = [];
  for (const turn of record.turns) {
    if (turn.eventType !== 'hook_error') continue;
    out.push({
      detector: 'HOOKERR',
      severity: def.severity,
      turnStart: turn.index,
      turnEnd: turn.index,
      toolCallIds: [],
      evidence: {},
    });
  }
  return out;
}
