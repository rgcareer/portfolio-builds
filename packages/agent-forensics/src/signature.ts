// A breakdown signature: one mechanically-detected failure pattern in a run. Evidence holds
// only scalars (counts, enums, hashes) — never free text — so signatures are as redacted as
// the records they come from.

import type { DetectorName, Severity } from './protocol';

export type Scalar = string | number | boolean | null;

export interface Signature {
  detector: DetectorName;
  severity: Severity;
  /** first turn index the signature spans (a turn index, or a tool call's callTurn). */
  turnStart: number;
  /** last turn index the signature spans. */
  turnEnd: number;
  /** tokenized tool-call ids implicated (empty for turn-only signatures). */
  toolCallIds: string[];
  evidence: Record<string, Scalar>;
}
