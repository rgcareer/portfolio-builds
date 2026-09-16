// agenteval Agent Trace v1 adapter. Reuses the shared lossless fromAgentTrace/toAgentTrace so
// agenteval's own checkers stay usable. Agent Trace records are verbatim (they carry the
// original text) — this adapter is for interop and conversion, NOT for the redacted own-
// sessions corpus, which comes only from the Claude Code adapter.

import { readFileSync } from 'node:fs';
import { fromAgentTrace, toAgentTrace, parseRunRecord } from '@portfolio-builds/shared';
import type { RunRecord, AgentTraceV1 } from '@portfolio-builds/shared';

/** Parse an Agent Trace v1 object into a validated RunRecord (verbatim). */
export function fromAgentTraceObject(trace: AgentTraceV1, adapter = 'agent-trace-v1'): RunRecord {
  return parseRunRecord(fromAgentTrace(trace, adapter), 'agent-trace-v1');
}

/** Read an Agent Trace v1 file and convert it to a validated RunRecord. */
export function fromAgentTraceFile(path: string): RunRecord {
  const trace = JSON.parse(readFileSync(path, 'utf8')) as AgentTraceV1;
  return fromAgentTraceObject(trace);
}

/** Round-trip a RunRecord back to Agent Trace v1 (for agenteval checkers). */
export function toAgentTraceV1(record: RunRecord): AgentTraceV1 {
  return toAgentTrace(record);
}
