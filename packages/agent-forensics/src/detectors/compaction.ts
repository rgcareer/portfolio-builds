import type { RunRecord } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// COMPACT (secondary): the session hit a compaction boundary or carried a compaction summary.
export function detectCompaction(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'COMPACT');
  const compactSummaries = Number(record.meta['compactSummaries'] ?? 0);
  const boundary = record.turns.find((t) => t.eventType !== undefined && /compact/.test(t.eventType));
  if (compactSummaries <= 0 && !boundary) return [];
  const at = boundary ? boundary.index : (record.turns[0]?.index ?? 0);
  return [
    {
      detector: 'COMPACT',
      severity: def.severity,
      turnStart: at,
      turnEnd: at,
      toolCallIds: [],
      evidence: { compactSummaries },
    },
  ];
}
