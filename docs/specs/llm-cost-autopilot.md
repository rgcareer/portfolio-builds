# Spec: @rgcareer/llm-cost-autopilot (bin `llm-cost`, npm script `lca`)

Build under `packages/llm-cost-autopilot/`. Read `tasks/conventions.md` first. Import everything shared
from `@portfolio-builds/shared` (subpaths where noted). Tests first; every LLM call in a test uses a mock.

## What it is
Prices real LLM traffic with the vendor's verified cache/batch multipliers and reports what caching (and,
in a secondary table, batching/routing) saved, as dollars with intervals, split by mechanism. The real
corpus is Ryan's own Claude Code transcripts (redacted, usage-only) plus any traffic captured today.

## Files
- `protocol/prices.json` — ALREADY WRITTEN (verified table). Do not modify it. Load it, do not hard-code prices.
- `protocol/policy.json` — you write it (content below).
- `src/protocol.ts` — `loadPolicy(dir?)` reads both protocol files, returns `{rules, prices, hash}` where
  `hash = sha256Canonical([pricesJson, policyJson])`. Also `PKG_ROOT`, `DATA_DIR` helpers.
- `src/prices.ts` — `priceUsage(model, usage, {batch?})` → `{inputUsd, outputUsd, totalUsd}` (throws on an
  unpriced model); `noCacheCounterfactual(usage)` → a usage object with all input classes moved to fresh;
  `minCacheablePrefix(model)`; `driftVsShared()` → names any model whose shared `LLM_PRICES` differs from
  the verified table. `usage` shape = shared `TrafficUsage` (`input, cacheRead, cacheCreation5m,
  cacheCreation1h, output`). Billed = `input·in + cacheCreation5m·1.25·in + cacheCreation1h·2·in +
  cacheRead·cacheRead·in + output·out` (all /1e6). No-cache = `(input+cacheCreation5m+cacheCreation1h+
  cacheRead)·in + output·out`.
- `src/traffic.ts` — `readTraffic(dir)` loads all `*.jsonl` via shared `readTrafficJsonl`; `importLedger(dbPath)`
  reads the shared `Ledger` `calls` table (skip `mock=1` and `error IS NOT NULL`, tally skips; map
  `cache_creation_tokens`→`cacheCreation5m`, tag `ttlAssumed:'5m'`); window filter by ISO `ts`.
- `src/transcripts.ts` — `extractClaudeCode(root, tokenizer, window)` → `{records: TrafficRecord[], tallies}`.
  Stream each `~/.claude/projects/<dir>/<session>.jsonl` line by line (never JSON.parse a whole file).
  Group assistant records by `message.id` (one API call), take usage once, drop split-block duplicates.
  For each call emit a TrafficRecord: `source:'claude-code'`, `model = message.model`, usage from
  `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation.ephemeral_5m_input_tokens`/`ephemeral_1h_input_tokens`; if only
  `cache_creation_input_tokens` is present put it in `cacheCreation5m`), `session = tokenizer(sessionId)`,
  `tags.project = tokenizer(dirname)`, `ts` = the record timestamp, `sidechain = isSidechain`,
  `latencyTolerant:false`. Drop cwd/gitBranch/uuid/requestId entirely. Tally excluded records by reason:
  `unpriced-model` (model not in prices.json and not banned), `alias-model` (`sonnet`/`opus`/`fable`
  bareword), `synthetic` (`<synthetic>`), `banned-model` (`claude-opus-5*`), `no-usage`.
- `src/counterfactual.ts` — `analyzeTraffic(records, policy, {protocolCommit, extractedAt})` →
  `{findings: CallFinding[], runMeta}`. Sum billed and no-cache over the priced window; per-session groups
  for the bootstrap; `kRead` = count of calls with `cacheRead>0`. `byMechanism()` splits savings into
  cache-read-avoided vs (secondary) batch vs routing. Batch savings apply ONLY to `latencyTolerant:true`
  records; routing savings are computed but flagged `quality_unverified:true` and excluded from headline totals.
- `src/bootstrap.ts` — `clusterBootstrap(groups, B, seed)` resampling whole sessions (each group =
  `{billed, noCache}`), returns `{pct, lo, hi}` for savedPct; `mulberry32(seed)`, B=2000, seed=20260915,
  percentile method.
- `src/budget.ts` — `class BudgetGuard(capUsd, ledger, thresholds=[0.5,0.8,1.0])` with `status()` →
  `{spent, cap, level: 'ok'|'warn'|'critical'|'stop'}`.
- `src/estimate.ts` — `estimateStep(calls)` → `{ceilingUsd, perModel}` using shared `estimateCostCeilingUsd`.
- `src/report.ts` — `analyze()` orchestration → writes `data/findings.json` + `data/run-meta.json` (canonical);
  `buildHeadlineValues(runMeta)` → the placeholder map; a `report(format)` renderer (`table`|`json`, md too).
- `src/index.ts`, `src/cli.ts`.

## Headline (put the template in policy.json, render via shared `renderHeadline`)
"Across {n} real Claude API calls in {sessions} of my own Claude Code sessions ({from} to {to}), prompt
caching cut the bill from ${nocache} (every input token at the fresh rate) to ${billed} actually billed at
list rates: {savedPct}% saved (session-level bootstrap 95% CI {lo}-{hi}%); {kRead} of {n} calls ({pRead}%,
95% Wilson CI {loR}-{hiR}%) read from cache."
Denominator n = deduplicated priced calls in the window. If n=0 or the salt is absent, run-meta has
`pct:null`, the generator refuses, and the README says "Not yet measured."

## policy.json content (you write; static)
`{version:1, frozen_on:'2026-09-15', window:{from:'2026-08-16', to:'2026-09-15'}, dedupe_key:'message.id',
inclusion:'model in prices.json', exclusion_reasons:[...the five above...], redaction:{session:'HMAC',
project:'HMAC', dropped:['cwd','gitBranch','uuid','requestId']}, counterfactual:{nocache, batch_only_if_
latency_tolerant, routing_excluded_quality_unverified, ledger_ttl_assumed:'5m'}, bootstrap:{B:2000,
seed:20260915, unit:'session'}, headline_template:'...above...', not_measured:['Admin API billed totals',
'latency','quality of downgrades','calls outside Claude Code']}`

## CLI (citty; every command `--json`; exit 0 ok / 1 check-failed-or-no-run / 2 usage)
`extract --root <dir> --from --to` (refuses without `PB_ANON_SALT` via shared `requireSalt`) · `capture
--ledger <db> --out <jsonl>` · `analyze [--traffic dir]` · `headline` · `repro` · `estimate --plan <jsonl>`
· `budget --cap <usd> --ledger <db>` (exit 1 at stop) · `report --format table|json|md`.

## Tests (name each; ≥30; mock/fixture only, $0)
prices: verified table values; multipliers 0.1/0.025/1.25/2; batch halves in+out and stacks; reproduces the
known real usage line opus-4-8 in=2912/out=1374 → $0.0489 at 1x cache accounting; `driftVsShared` reports none now (shared
was corrected to 2/10); unpriced model throws. transcripts: dedupe by message.id on a split-block fixture;
final usage kept; ids dropped; session/project HMAC'd; tallies each exclusion reason; window filter inclusive;
sidechain preserved; output passes `assertNoPii`. traffic: JSONL round-trip; `importLedger` skips mock/error
with tallies; ttlAssumed tag. counterfactual: 1h write at 2x; no-cache = fresh; already-cached never double
counted; batch only when tolerant; routing excluded from headline; mechanisms sum to total. bootstrap:
deterministic for a seed; interval contains the point; single-session degenerate → [p,p]. budget: alerts at
50/80/100%; stop at ≥cap. estimate: uses estimateCostCeilingUsd, labelled ceiling. protocol: hash covers both
files. report: run-meta deterministic except generatedAt; headline refuses without pct. cli: `--json` parses;
unknown cmd exit 2; headline without a run exit 1.

## Repro & audits (the main session registers these in tests.json; you just make them pass)
`lca repro` re-derives findings.json + run-meta.json from `data/traffic/*.jsonl` + protocol offline, bit-for-bit
(exclude `generatedAt`). Provide `scripts`-style checks the main session will wire: price-recompute (plain JS
recompute of billed/nocache from the JSONL + prices.json equals run-meta to the cent), pii-sweep of `data/`,
readme-headline. Do NOT edit tests.json.

## Build order
protocol loader → prices → transcripts extractor (fixtures) → counterfactual + bootstrap → report/headline/repro
→ CLI. Real `extract` over `~/.claude/projects` runs later (main session, with the salt). Return blocked if any
measured-number contract is ambiguous.
