import type { RunRecord, ToolCall } from '@portfolio-builds/shared';
import type { Protocol } from '../protocol';
import { detectorDef } from '../protocol';
import type { Signature } from '../signature';

// RETRY: >= min_consecutive_errors consecutive is_error results for ONE tool, with no
// success between them.
export function detectRetry(record: RunRecord, protocol: Protocol): Signature[] {
  const def = detectorDef(protocol, 'RETRY');
  const min = def.min_consecutive_errors ?? 3;
  const byName = new Map<string, ToolCall[]>();
  for (const c of record.toolCalls) {
    const arr = byName.get(c.name);
    if (arr) arr.push(c);
    else byName.set(c.name, [c]);
  }
  const out: Signature[] = [];
  for (const [name, calls] of byName) {
    let run: ToolCall[] = [];
    const flush = () => {
      if (run.length >= min) {
        out.push({
          detector: 'RETRY',
          severity: def.severity,
          turnStart: run[0]!.callTurn,
          turnEnd: run[run.length - 1]!.callTurn,
          toolCallIds: run.map((c) => c.id),
          evidence: { name, consecutiveErrors: run.length },
        });
      }
      run = [];
    };
    for (const c of calls) {
      if (c.isError) run.push(c);
      else flush();
    }
    flush();
  }
  return out;
}
