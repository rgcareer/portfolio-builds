# Spec: @rgcareer/agent-forensics (bin `agent-forensics`, npm script `agent-forensics`)

Build under `packages/agent-forensics/`. Read `tasks/conventions.md`. Import shared from
`@portfolio-builds/shared` (esp. `runrecord`, `redact`, `pii`, `wilson`, `stableJson`). Tests first. $0 — no
LLM call anywhere. The privacy guarantee is the load-bearing feature; the canary test is mandatory.

## What it is
Post-mortem tooling for agent runs. It normalizes Claude Code transcripts (and agenteval traces) into a shared
`RunRecord` that is redacted BY CONSTRUCTION (no free text — only hashes, lengths, enums, ISO timestamps, HMAC
tokens), detects breakdown signatures mechanically, and renders a timeline with a blame span and a minimal
repro slice. Headline measured on Ryan's own 187 sessions.

## Files
- `protocol/detectors.json` (you write) — version; frozen_on; source description; tolerant-parse rules;
  kept-key allowlist for `toolUseResult` (`durationMs, timedOutAfterMs, interrupted, totalTokens,
  totalToolUseCount, isAgent, success`, plus `status` matching `^[a-z_-]{1,32}$`); never-kept list (all text,
  thinking, tool inputs/outputs, attachments, titles, summaries, lastPrompt, file-history, account/org uuids);
  first-party tool-name allowlist (Bash, Read, Edit, Write, Agent, Skill, WebFetch, WebSearch, ToolSearch,
  Glob, Grep, NotebookEdit, TodoWrite, Task, and the like — anything else incl. `mcp__*` → `other:<hmac8>`);
  error-class regexes (`exit-nonzero, not-found, permission, timeout, interrupted, no-matches, other`);
  detector definitions with thresholds (below); headline set; denominators; headline template; not_measured
  (silent wrong-output failures — no output-verification layer; subagent transcripts absent; anything after
  ingest). `protocol/taxonomy.json` — each detector → one MAST category ('system-design'|'inter-agent'|
  'verification'), labelled "author's mapping"; NO prevalence numbers.
- `src/protocol.ts`; `src/redact.ts` (`makeTokenizer`-based; `keepScalar(key, value)`, `errorClassOf(raw)`,
  `toolNameOf(raw)`); `src/adapters/claudeCode.ts` (`parseTranscript(lines, {salt, protocol})`,
  `ingestClaudeCodeDir(dir, {salt, protocol, onFile?})`); `src/adapters/agentTrace.ts` (`fromAgentTraceFile`);
  `src/detectors/{loop,retry,apiError,refusal,dangling,hookError,timeout,toolError,denial,interrupt,
  compaction}.ts` + `index.ts` (`runDetectors(record, protocol) → Signature[]`, `Signature {detector, severity,
  turnStart, turnEnd, toolCallIds, evidence: Record<string, scalar>}`); `src/timeline.ts` (`buildTimeline`,
  `blameSpan` = earliest highest-severity signature, `minimalRepro` = shortest suffix reproducing the
  signature); `src/analyze.ts` (`analyzeRecords(records, protocol, meta)`); `src/precision.ts`
  (`precisionRecall(fixtures, protocol)`); `src/audit.ts` (`redactionAudit(value, protocol) → Violation[]`);
  `src/report.ts`, `src/index.ts`, `src/cli.ts`.
- `test/fixtures/transcripts/*.jsonl` (synthetic, carrying canaries), `fixtures/labeled/*.json` (40 labeled
  RunRecords under a FIXED test salt), `data/records/<s_token>.json`, `data/{findings,run-meta,run-state,
  ingest-ledger}.json` (records excluded from npm `files`).

## Adapter rules (tolerant, redacting)
Stream lines; blank skipped; malformed → count in `malformedLines`; unknown `type` → count in `unknownTypes`,
never throw; collect every `version` into `source.schemaVersions`. Assistant records grouped by `message.id`
(fallback own `uuid`), blocks ordered, usage once → one `llm` turn (stopReason, model, usage); text →
textHash+textChars; thinking → count/chars in meta only; `tool_use` → ToolCall. User records: string content →
`prompt` turn (hash+chars; `isMeta`/`isCompactSummary` excluded, counted); array `tool_result` paired by
`tool_use_id`, deduped by record `uuid`, unmatched → `orphan:true`; `toolDenialKind` → `denied:true`;
`toolUseResult` scalars only from the allowlist. System `subtype` allowlist → `system_event`; `api_error` →
`error.class`; `hookErrors` non-empty → count; refusal stop or `model_refusal_*` → refusal event. `cwd`→`p_`
token, `sessionId`→`s_` token, `gitBranch` hashed; `permissionMode`,`entrypoint`,`version` kept. Error class by
the protocol regexes over raw text; only the label emitted. Observed `claude-opus-5` model strings → bucket
`excluded:banned-model`, count disclosed. redaction is `'hashed'`; every record must satisfy `parseRunRecord`.

## Detectors (thresholds in detectors.json)
LOOP: ≥3 calls with the same `(name, inputHash)` and identical `resultHash` within a 10-call window. RETRY: ≥3
consecutive `is_error` results for one tool with no success between. APIERR: an assistant API-error record or
system `api_error`. REFUSAL: refusal stop / `model_refusal_*`. DANGLE: call without result (evidence
`atSessionEnd`). HOOKERR: `hookErrors` non-empty. TIMEOUT: `timedOut` or error-class timeout. Reported
separately (not headline): TOOLERR (per-call error rate), DENIAL, INTERRUPT, COMPACT. Headline set = {LOOP,
RETRY, APIERR, REFUSAL, DANGLE, HOOKERR, TIMEOUT}.

## Headline (sessions are the sampling unit; render via `renderHeadline`; $0)
"Across {sessions} of my own Claude Code sessions ({from} to {to}; {tool_calls} tool calls), {k} ({p}%, 95%
Wilson CI {lo}-{hi}%) contain at least one pre-registered breakdown signature; the most frequent is
{top_class} ({top_k} sessions); {err_calls} tool calls ({err_p}%, CI {err_lo}-{err_hi}%) returned an error."
Denominator = every JSONL file under the ingest dir at ingest time (zero-assistant files counted and excluded,
disclosed). Detector precision/recall on `fixtures/labeled/` is a table with "measured against the detectors'
own specification, not real-world precision".

## CLI (citty; `--json`; exit 0/1/2)
`ingest --dir <dir> --out data/records` (refuses without `PB_ANON_SALT`; never writes raw) · `analyze` ·
`headline` · `repro` · `report <record> [--json]` · `detect <record>` (exit 1 on any headline-set signature) ·
`convert --from agent-trace|claude-code <file>` · `audit data/` (exit 1 on any violation) · `show --raw
<session.jsonl> --turns a-b` (local-only human view; documented as never committed).

## Tests (name each; ≥35)
adapter: groups split assistant records, usage once; dedupes re-emitted results by uuid; pairs by tool_use_id;
orphan & dangling; unknown types/malformed counted; schemaVersions collected; `toolUseResult` stdout/command
dropped while durationMs kept; thinking→counts only; compaction summary not a prompt; sidechain tolerated; MCP
tool name hashed. redaction canary (MANDATORY): a synthetic transcript containing an email, a phone,
`/Users/x/secret`, an `sk-ant-` key, a UUID, a `ghp_` token, and a distinctive sentence → `stableStringify(record)`
contains NONE of them; `findPii` empty; every string value is an allowlisted enum, an ISO timestamp, or an
hmac-shaped token (`isTokenShaped`); `redactionAudit` zero violations; ingest without salt throws; same salt→same
tokens; different salt→different. detectors: one positive + one near-miss negative each. precision: labeled
fixtures give P=R=1 per detector. timeline: blame span = earliest highest-severity; minimal repro = shortest
suffix reproducing the signature. analyze: counts, Wilson strings, top-class ordering (count desc, name asc),
determinism, headline renders from run-meta, refuses at n=0. agentTrace: agenteval sample converts, validates,
round-trips. audit: a record with a forbidden key (`content`,`stdout`,`cwd`), an absolute-path shape, or a
string over 64 chars fails. cli, repro.

## Repro & audits (main session wires tests.json)
`agent-forensics repro` re-derives findings.json + run-meta.json from `data/records/*` offline, bit-for-bit.
Provide logic for protocol-frozen (both files hash vs run-state, commit precedes ingestedAt), redaction-audit
(walk `data/` + `fixtures/`: findPii, forbidden keys, path shapes `/Users/`,`~/`,`C:\`, non-allowlisted keys,
non-hmac ids, strings >64 chars, non-RunRecord files), readme-headline.

## Build order
protocol → redact + adapter with the canary test FIRST → detectors + labeled fixtures → timeline → analyze/report
→ CLI → audit script. The main session runs `ingest` over `~/.claude/projects` with the salt later. Return
blocked on any redaction/denominator ambiguity.
