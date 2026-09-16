import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// REFUSAL: an llm turn whose stop reason is a refusal, or a system model_refusal_* event
// (surfaced as an eventType 'refusal' turn).
export function detectRefusal(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'REFUSAL');
  const out: Signature[] = [];
  for (const turn of record.turns) {
    const byStop = turn.kind === 'llm' && typeof turn.stopReason === 'string' && /refusal/.test(turn.stopReason);
    const byEvent = turn.eventType === 'refusal';
    if (!byStop && !byEvent) continue;
    out.push({
      detector: 'REFUSAL',
      severity: def.severity,
      turnStart: turn.index,
      turnEnd: turn.index,
      toolCallIds: [],
      evidence: { via: byStop ? 'stop_reason' : 'system_event' },
    });
  }
  return out;
}
