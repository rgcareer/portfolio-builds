# Agent Forensics

Post-mortem tooling for Claude Code sessions: turns a transcript into a redacted record, runs
a frozen set of mechanical detectors over it, and points at the exact turn where a run broke.

## Result

Not yet measured.

```
$ node --import tsx src/cli.ts headline
headline: no data/run-meta.json — run analyze first
```

No sessions have been ingested yet, so there is no `data/run-meta.json` to render a headline
from. This section will hold the `renderHeadline` output verbatim once a run exists, along
with the protocol hash, commit, and cost it was rendered from.

## What it does / measures

Given a directory of Claude Code `*.jsonl` transcripts, it:

1. Parses each file into a `RunRecord` that is redacted by construction: tool inputs, outputs,
   stdout/stderr, file paths, and prompt text never enter the record. What survives is counts,
   durations, booleans, small enums, and HMAC tokens, so a session can be joined across files
   without exposing what was in it.
2. Runs eleven pre-registered detectors against each record: `LOOP`, `RETRY`, `APIERR`,
   `REFUSAL`, `DANGLE`, `HOOKERR`, and `TIMEOUT` form the headline set; `TOOLERR`, `DENIAL`,
   `INTERRUPT`, and `COMPACT` are reported separately and never count toward the headline.
3. Maps each detector to one of three top-level MAST (Multi-Agent System failure Taxonomy)
   categories (`system-design`, `inter-agent`, `verification`) as a labeling convenience, not
   an empirical claim about prevalence.
4. Builds a timeline per session, picks the highest-severity signature as the blame span, and
   slices out the minimal run of turns that reproduces it.
5. Aggregates across every ingested session into `run-meta.json`: achieved n, k sessions with
   at least one headline signature, a 95% Wilson interval on that proportion, the most frequent
   headline detector, and the tool-call error rate with its own interval.

## Quick start

```bash
npx tsx src/cli.ts ingest --dir ~/.claude/projects/<your-project-slug>
npx tsx src/cli.ts analyze
npx tsx src/cli.ts headline
```

`ingest` refuses to run without `PB_ANON_SALT` set, since redaction depends on that salt.

## CLI

| Command | Does |
|---|---|
| `ingest --dir <dir> [--out data/records]` | Redacts every `*.jsonl` transcript under `dir` into a `RunRecord`, writes `run-state.json` and `ingest-ledger.json`. Refuses without `PB_ANON_SALT`. |
| `analyze` | Derives `findings.json` and `run-meta.json` from `data/records`. Refuses at zero records. |
| `headline` | Renders the headline sentence from the committed `run-meta.json`. |
| `repro` | Re-derives `findings.json` and `run-meta.json` from committed records, offline, and checks the result matches bit for bit. |
| `report <record.json> [--json]` | Prints a post-mortem for one record: signatures, blame span, minimal repro, timeline. |
| `detect <record.json> [--json]` | Lists the signatures found in one record; exits 1 if any is in the headline set. |
| `convert --from agent-trace\|claude-code <file>` | Converts one file to a `RunRecord` and prints it. |
| `audit [dir]` | Sweeps committed `data/` and `fixtures/` for redaction violations; exits 1 on any. |
| `show --raw <file> [--turns a-b]` | Local-only, human-readable view of a raw transcript. Never commit this output. |

## Library API

```ts
import {
  parseTranscript, ingestClaudeCodeDir,
  runDetectors, hasHeadlineSignature, DETECTORS,
  buildTimeline, blameSpan, minimalRepro,
  analyzeRecords, headlineFromRunMeta,
  report, renderReportText,
  redactionAudit, auditTree, protocolFrozen,
  reproduce,
} from '@rgcareer/agent-forensics';
```

`analyzeRecords(records, protocol, meta)` is the pure aggregation step: same records and
protocol always produce the same `findings` and `runMeta`. `report(record, protocol)` builds
the per-session view used by the CLI's `report` command.

## How it decides

Everything is frozen in `protocol/detectors.json` and `protocol/taxonomy.json` before any
transcript is read, and `loadProtocol` hashes both files together (`sha256Canonical`). That
hash is written into `run-state.json` at ingest time; a `protocol-frozen` audit fails if the
committed protocol no longer matches, so a detector's window, threshold, or the headline
template cannot be tuned after data collection to fit a result.

- `LOOP`: three or more tool calls with an identical name, input hash, and result hash inside
  a sliding window of ten consecutive calls.
- `RETRY`: three or more consecutive error results on one tool with no success between them.
- `APIERR`: an assistant API-error record or a system `api_error` event.
- `REFUSAL`: a turn with a refusal stop reason, or a system `model_refusal_*` event.
- `DANGLE`: a tool call that never received a result before the session ended.
- `HOOKERR`: a record carrying a non-empty `hookErrors` array.
- `TIMEOUT`: a tool call that timed out.
- `TOOLERR`, `DENIAL`, `INTERRUPT`, `COMPACT`: reported per record, never in the headline.

Error text is classified into one of six labels (`timeout`, `permission`, `not-found`,
`no-matches`, `interrupted`, `exit-nonzero`, falling back to `other`) by regex, in a fixed
order; only the label is kept, never the raw text.

## Reproduce

```bash
node --import tsx src/cli.ts repro
```

`repro` re-derives `findings.json` and `run-meta.json` from the committed `data/records/*.json`
and the frozen protocol, entirely offline, and fails if the result differs from what is
committed by even one byte (excluding `generatedAt`). It has nothing to reproduce until a run
has been ingested and analyzed at least once.

## Cost

LLM calls: none. This package makes zero calls to `callLlm`; nothing here judges anything, it
only counts and classifies. Network: none. `ingest` reads local `.jsonl` files only.

## What is NOT measured

Carried verbatim from `protocol/detectors.json`:

- Silent wrong-output failures: there is no output-verification layer, so a session that
  finished with an incorrect answer but produced no error, loop, refusal, or dangle is not
  counted.
- Subagent or sidechain transcripts absent from the ingest directory.
- Anything that happened after ingest: later reruns, post-hoc edits, manual recovery.
- The `taxonomy.json` MAST mapping is a labeling convenience the author chose. It carries no
  prevalence numbers and asserts nothing about how often each category occurs in the wild.

## Failure modes

- A tool call whose name and inputs happen to repeat legitimately (for example, polling the
  same file for a status change) can trip `LOOP` even though nothing broke.
- `DANGLE` depends on the transcript ending mid-call; a session terminated by the harness for
  an unrelated reason can look identical to one abandoned by the agent.
- Error classification is regex-based against lower-cased text in a fixed label order, so a
  message matching two patterns is assigned to whichever label comes first, not necessarily
  the more specific one.
- `ingest` counts and excludes zero-assistant files rather than silently dropping them, but a
  transcript with one assistant turn and nothing else still counts as a session.

## Security

See [SECURITY.md](./SECURITY.md).

## License

MIT
