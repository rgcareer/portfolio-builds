import type { RunRecord, ToolCall } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// TOOLERR (secondary, not in the headline): a per-tool error rate — a tool with >= min_calls
// calls and >= min_errors error results.
export function detectToolError(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'TOOLERR');
  const minCalls = def.min_calls ?? 5;
  const minErrors = def.min_errors ?? 2;
  const byName = new Map<string, ToolCall[]>();
  for (const c of record.toolCalls) {
    const arr = byName.get(c.name);
    if (arr) arr.push(c);
    else byName.set(c.name, [c]);
  }
  const out: Signature[] = [];
  for (const [name, calls] of byName) {
    const errors = calls.filter((c) => c.isError);
    if (calls.length < minCalls || errors.length < minErrors) continue;
    out.push({
      detector: 'TOOLERR',
      severity: def.severity,
      turnStart: calls[0]!.callTurn,
      turnEnd: calls[calls.length - 1]!.resultTurn ?? calls[calls.length - 1]!.callTurn,
      toolCallIds: errors.map((c) => c.id),
      evidence: { name, calls: calls.length, errors: errors.length },
    });
  }
  return out;
}
