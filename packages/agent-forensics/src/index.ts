// @rgcareer/agent-forensics — public API. Post-mortem tooling for agent runs: normalize
// Claude Code transcripts (and agenteval traces) into a redacted-by-construction RunRecord,
// detect breakdown signatures mechanically, and render a timeline with a blame span and a
// minimal repro slice. $0 — no LLM call anywhere.

export * from './protocol';
export * from './redact';
export * from './signature';
export { parseTranscript, ingestClaudeCodeDir, type ParseOptions, type IngestResult } from './adapters/claudeCode';
export { fromAgentTraceFile, fromAgentTraceObject, toAgentTraceV1 } from './adapters/agentTrace';
export { runDetectors, detectorSet, hasHeadlineSignature, DETECTORS } from './detectors';
export { buildTimeline, blameSpan, minimalRepro, type Timeline, type TimelineEntry, type MinimalRepro } from './timeline';
export {
  analyzeRecords,
  headlineFromRunMeta,
  writeAnalysis,
  readRecords,
  type Findings,
  type RunMeta,
  type RecordFinding,
} from './analyze';
export { precisionRecall, type PrecisionReport, type DetectorPR } from './precision';
export { report, renderReportText, type Report, type SignatureView } from './report';
export { redactionAudit, auditTree, protocolFrozen, type Violation, type TreeAuditResult, type RunState } from './audit';
export { reproduce, type ReproResult } from './repro';
