# llm-cost-autopilot

Prices real Claude API traffic against the vendor's own cache and batch multipliers, then reports what caching actually saved as dollars with a confidence interval.

## Result

Not yet measured.

No `data/run-meta.json` has been committed yet. `node --import tsx src/cli.ts headline` and `node --import tsx src/cli.ts report --format md` both exit 1 with "no run-meta.json yet; run `analyze` first" against a clean checkout, so there is nothing to quote here. Extraction runs later, against `~/.claude/projects`, with `PB_ANON_SALT` set.

## What it does

Every Claude API call already carries the numbers needed to price it: token counts by class (fresh input, cache read, cache write, output) and a model name. This package reads those numbers from real traffic (Claude Code's own transcripts, or a captured ledger), prices each call against a hand-verified rate table, and compares that to a counterfactual where every input token was billed at the fresh rate instead. The difference is what prompt caching saved.

It does not estimate, guess, or simulate a bill. It also does not touch the Admin API. Both are real gaps, listed below rather than papered over.

## Quick start

```bash
# extract Ryan's own Claude Code transcripts (needs PB_ANON_SALT, an HMAC salt, never committed)
node --import tsx src/cli.ts extract --root ~/.claude/projects --from 2026-08-16 --to 2026-09-15

# price the extracted traffic and write data/findings.json + data/run-meta.json
node --import tsx src/cli.ts analyze

# the one-line headline, rendered only from the committed run-meta.json
node --import tsx src/cli.ts headline

# a full report
node --import tsx src/cli.ts report --format md
```

## CLI

Every command is `citty`-based, accepts `--json`, and uses exit codes 0 (ok), 1 (check failed or no run yet), 2 (usage error).

| command | flags | what it does |
|---|---|---|
| `extract` | `--root --from --to` | Streams `~/.claude/projects/**/*.jsonl` line by line, groups by `message.id`, tokenizes session and project with an HMAC salt, writes `data/traffic/claude-code.jsonl`. Refuses without `PB_ANON_SALT`. |
| `capture` | `--ledger --out` | Reads the shared cost ledger, skips mock and errored rows (tallied), writes a traffic JSONL. |
| `analyze` | `[--traffic dir]` | Reads every `*.jsonl` under the traffic dir, prices it, writes `data/findings.json` and `data/run-meta.json`. |
| `headline` | | Renders the one-sentence headline from `data/run-meta.json` via `renderHeadline`. Exits 1 if no run exists or `pct` is null. |
| `repro` | | Recomputes `findings.json`/`run-meta.json` from the committed traffic and protocol, offline, and diffs against what's checked in (`generatedAt` excluded). |
| `estimate` | `--plan <jsonl>` | Given a planned batch of calls, prints a cost ceiling per model via the shared conservative estimator. |
| `budget` | `--cap --ledger` | Prints spend against a cap and an alert level (`ok`/`warn`/`critical`/`stop`); exits 1 at `stop`. |
| `report` | `--format table\|json\|md` | Renders `n`, sessions, window, billed, no-cache, saved, cache-read count, and the mechanism breakdown. |

## Library API

```ts
import {
  loadPolicy, priceUsage, noCacheCounterfactual, minCacheablePrefix, isPricedModel,
  driftVsShared, readTraffic, importLedger, extractClaudeCode, analyzeTraffic, byMechanism,
  clusterBootstrap, BudgetGuard, estimateStep, analyze, buildHeadlineValues, renderReportHeadline, report,
} from '@rgcareer/llm-cost-autopilot';
```

`priceUsage(model, usage, { batch? })` throws on any model not in `protocol/prices.json` rather than guessing a rate. `noCacheCounterfactual(usage)` moves every input-token class (fresh, cache-read, cache-creation) to fresh input; output pricing is untouched, since caching never changes it.

## How it decides

- **Billed** = `input·in + cacheCreation5m·1.25·in + cacheCreation1h·2·in + cacheRead·cacheRead_multiplier·in + output·out`, all per the model's row in `protocol/prices.json` and divided by 1e6.
- **No-cache counterfactual** = the same formula with every input class collapsed into fresh input. This is "what if caching had never run," not "what if the call never happened."
- **Dedup** is by `message.id`: a single API call can appear as several JSONL lines (one per streamed content block), and every line for one call repeats the same cumulative usage, so only the first occurrence is kept.
- **Exclusions** are tallied, not dropped silently: `unpriced-model`, `alias-model` (a bareword like `sonnet` instead of a full id), `synthetic` (`<synthetic>`), `banned-model` (`claude-opus-5*`), `no-usage`.
- **The percent-saved interval** is a session-level cluster bootstrap (2,000 resamples, seed 20260915, whole sessions resampled with replacement, not individual calls, because calls inside one session are not independent draws) via `mulberry32`, the only PRNG this repo allows.
- **The cache-read-rate interval** is a plain Wilson interval over calls, since whether a given call hit cache is closer to an independent coin flip than the dollar saved is.
- **Mechanisms**: `cache` is realized savings and is the only one in the headline. `batch` and `routing` are hypothetical, additional savings this traffic *could* have captured, computed but never counted as having happened: `batch` only applies to calls flagged `latencyTolerant`, and `routing` (repricing every call at the cheapest model in the table) is explicitly flagged `quality_unverified` because nothing here checks whether the cheaper model would have produced an acceptable answer.
- A protocol hash (`sha256Canonical` over both `protocol/*.json` files) is stamped into every `run-meta.json`, so a later `protocol-frozen` audit can catch a table edited after data was collected.

## Reproduce

```bash
node --import tsx src/cli.ts repro
```

Re-derives `data/findings.json` and `data/run-meta.json` from the committed `data/traffic/*.jsonl` and the frozen protocol files, fully offline, and diffs the result against what's checked in (ignoring the `generatedAt` timestamp). A mismatch means the checked-in output no longer matches its own inputs.

## Cost

This package makes no LLM calls. It only reads transcripts and a ledger, then does arithmetic against a static price table. `PB_SPEND_CAP_USD` and `callLlm` are irrelevant here; `estimate` and `budget` exist to help other packages watch their own LLM spend.

## What is NOT measured

Per `protocol/policy.json`:

- Admin API billed totals (this reads Claude Code transcripts and the ledger, not Anthropic's billing dashboard)
- latency
- quality of any model downgrade the `routing` mechanism hypothesizes
- calls outside Claude Code (unless captured separately through `capture`)

## Failure modes

- **No traffic yet**: `analyze` writes `n: 0`, `pct: null`; `headline` refuses rather than print an unmeasured percentage.
- **Missing salt**: `extract` exits 1 immediately; it never runs unsalted.
- **Unpriced model**: `priceUsage` throws; `toFinding` catches it and drops the record rather than guessing a price. Real exclusions are tallied under `unpriced-model`.
- **Single-session run**: the bootstrap interval collapses to `[point, point]` since there's nothing to resample.
- **Protocol edited after data was collected**: the stamped hash in `run-meta.json` won't match a hash recomputed from the current protocol files; that's what the `protocol-frozen` audit checks.

## Security

See [SECURITY.md](./SECURITY.md). Briefly: raw prompts, transcript paths, and identifiers are never committed; session and project identifiers are HMAC-tokenized with a salt that itself is never committed or printed; the extractor refuses to run without that salt.

## License

MIT
