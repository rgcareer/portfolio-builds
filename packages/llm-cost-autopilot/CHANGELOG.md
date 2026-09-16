# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] - 2026-09-15

### Added
- Verified price table (`protocol/prices.json`) and frozen policy (`protocol/policy.json`) covering claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5, claude-fable-5, and claude-fable-5-1, with `claude-opus-5` recorded as banned.
- `priceUsage` / `noCacheCounterfactual` / `minCacheablePrefix` / `isPricedModel` / `driftVsShared` for pricing traffic against the verified table.
- A Claude Code transcript extractor (`extractClaudeCode`) that streams `~/.claude/projects/**/*.jsonl` line by line, dedupes by `message.id`, and HMAC-tokenizes session and project identifiers.
- A ledger importer (`importLedger`) that skips mock and errored rows and tallies why.
- `analyzeTraffic` / `byMechanism`: prices real traffic against the no-cache counterfactual, splits savings into realized (cache) and hypothetical (batch, routing), and builds the session-level bootstrap and Wilson interval behind the headline.
- `clusterBootstrap` (session-level, B=2000, seed 20260915, `mulberry32`) and a Wilson interval for the cache-read rate.
- `BudgetGuard` (spend levels against a cap) and `estimateStep` (pre-call cost ceiling for a planned batch).
- CLI (`extract`, `capture`, `analyze`, `headline`, `repro`, `estimate`, `budget`, `report`) with `--json` on every command and the 0/1/2 exit-code contract.
- 83 tests covering pricing, extraction, traffic import, counterfactual accounting, bootstrap determinism, budget thresholds, estimate, protocol hashing, report rendering, and CLI dispatch.

### Not yet done
- No real extraction has run against `~/.claude/projects` yet, so `data/run-meta.json` does not exist and the headline is not yet measured.
