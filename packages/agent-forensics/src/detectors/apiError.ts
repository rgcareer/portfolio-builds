import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// APIERR: an assistant API-error record or a system api_error event (both surface as an
// api_error system_event turn during adaptation).
export function detectApiError(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'APIERR');
  const out: Signature[] = [];
  for (const turn of record.turns) {
    const isApi = turn.eventType === 'api_error' || turn.error?.class === 'api-error';
    if (!isApi) continue;
    out.push({
      detector: 'APIERR',
      severity: def.severity,
      turnStart: turn.index,
      turnEnd: turn.index,
      toolCallIds: [],
      evidence: turn.error?.status !== undefined ? { status: turn.error.status } : { status: null },
    });
  }
  return out;
}
