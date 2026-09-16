---
slug: llm-cost-autopilot
title: LLM Cost Autopilot
tagline: Prices real Claude traffic against the vendor's own cache multipliers and reports what caching actually saved.
role: Design + build
year: '2026'
status: not yet measured
stack:
  - TypeScript
  - Node.js
  - citty
metrics: []
tags:
  - llm
  - finops
  - cost
  - prompt-caching
links:
  repo: https://github.com/rgcareer/llm-cost
metrics_source: {}
---

## Lead

Not yet measured. `data/run-meta.json` does not exist yet, so there is no headline number to report here. `node --import tsx src/cli.ts headline` and `node --import tsx src/cli.ts report --format md` both exit 1 with "no run-meta.json yet; run `analyze` first" as of this writing.

## Problem

Every LLM bill I've looked at mixes a few very different things: what got billed at list rate, what got a cache discount, and what could have been cheaper with a different model or batching. Vendors publish the discount multipliers, but nothing turns "here's the multiplier table" into "here's what your own traffic actually saved," with an interval instead of a single suspicious-looking number.

## Approach

The package prices real traffic (Claude Code's own transcripts, or a captured cost ledger) against a hand-verified rate table, then computes a counterfactual: the same traffic with every input token billed at the fresh rate instead of whatever cache class it actually used. The gap between the two is what caching saved, and it's the only mechanism that goes in the headline. Two more mechanisms, batch and cheapest-model routing, are computed as hypothetical additional savings and kept out of the headline, since one requires a latency tolerance this traffic doesn't have on record and the other assumes a cheaper model would have produced an acceptable answer, which nothing here verifies.

The percent-saved interval comes from a session-level cluster bootstrap rather than a call-level one, because calls inside the same session are not independent draws, and resampling them individually would understate the interval.

## The honesty feature

`headline` refuses to print anything when no run exists or `pct` is null, rather than fall back to a plausible-looking placeholder. Every exclusion (an unpriced model, a bareword alias like `sonnet`, the synthetic marker, the banned `claude-opus-5`, a record with no usage at all) is tallied and disclosed, not dropped silently. The mechanism breakdown labels `routing` as `quality_unverified` in its own output, so a reader can't mistake a hypothetical for a measured saving.

## How I verified it

83 tests pass (`npx vitest run packages/llm-cost-autopilot`), and `npx tsc --noEmit` is clean. I ran the package's own `headline` and `report --format md` commands against a clean checkout; both correctly exit 1 and report no run exists, which is why this case study says "not yet measured" instead of a number. `repro` re-derives the two committed output files from the traffic snapshot and protocol, offline, byte for byte except the generation timestamp, once a real run exists to check.
