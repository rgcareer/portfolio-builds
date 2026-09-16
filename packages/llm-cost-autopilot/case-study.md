---
slug: llm-cost-autopilot
title: LLM Cost Autopilot
tagline: Prices real Claude traffic against the vendor's own cache multipliers and reports what caching actually saved.
role: Design + build
year: '2026'
status: built and measured
stack:
  - TypeScript
  - Node.js
  - citty
metrics:
  - label: Bill cut
    value: 84.7% (session-level bootstrap 95% CI 83.2-86.0%)
  - label: Calls cached
    value: 99.7% (95% Wilson CI 99.6-99.8%)
  - label: Real API calls priced
    value: '10703'
  - label: Sessions analyzed
    value: '85'
  - label: Actually billed
    value: $3959.81
  - label: No-cache counterfactual
    value: $25863.40
tags:
  - llm
  - finops
  - cost
  - prompt-caching
links:
  repo: https://github.com/rgcareer/llm-cost
metrics_source:
  Bill cut: data/run-meta.json#pct.savedPct (session-level bootstrap interval at pct.lo/pct.hi)
  Calls cached: data/run-meta.json#pct.pRead (Wilson interval at pct.loR/pct.hiR)
  Real API calls priced: data/run-meta.json#n
  Sessions analyzed: data/run-meta.json#sessions
  Actually billed: data/run-meta.json#billedUsd
  No-cache counterfactual: data/run-meta.json#noCacheUsd
---

## Lead

Across 10703 real Claude API calls in 85 of my own Claude Code sessions (2026-08-16 to 2026-09-15), prompt caching cut the bill from $25863.40 (every input token at the fresh rate) to $3959.81 actually billed at list rates: 84.7% saved (session-level bootstrap 95% CI 83.2-86.0%); 10669 of 10703 calls (99.7%, 95% Wilson CI 99.6-99.8%) read from cache.

That's the literal output of this package's own `headline` command, run against my own Claude Code traffic.

## Problem

Every LLM bill I've looked at mixes a few very different things: what got billed at list rate, what got a cache discount, and what could have been cheaper with a different model or batching. Vendors publish the discount multipliers, but nothing turns "here's the multiplier table" into "here's what your own traffic actually saved," with an interval instead of a single suspicious-looking number.

## Approach

The package prices real traffic (Claude Code's own transcripts, or a captured cost ledger) against a hand-verified rate table, then computes a counterfactual: the same traffic with every input token billed at the fresh rate instead of whatever cache class it actually used. The gap between the two is what caching saved, and it's the only mechanism that goes in the headline. Two more mechanisms, batch and cheapest-model routing, are computed as hypothetical additional savings and kept out of the headline, since one requires a latency tolerance this traffic doesn't have on record and the other assumes a cheaper model would have produced an acceptable answer, which nothing here verifies.

The percent-saved interval comes from a session-level cluster bootstrap rather than a call-level one, because calls inside the same session are not independent draws, and resampling them individually would understate the interval.

## The honesty feature

`headline` refuses to print anything when no run exists or `pct` is null, rather than fall back to a plausible-looking placeholder. Every exclusion (an unpriced model, a bareword alias like `sonnet`, the synthetic marker, the banned `claude-opus-5`, a record with no usage at all) is tallied and disclosed, not dropped silently. The mechanism breakdown labels `routing` as `quality_unverified` in its own output, so a reader can't mistake a hypothetical for a measured saving.

## How I verified it

83 tests pass (`npx vitest run packages/llm-cost-autopilot`), and `npx tsc --noEmit` is clean. I ran the package's own `headline` command against the committed `data/run-meta.json` and pasted its output verbatim above and in the README. `repro` re-derives the two committed output files from the traffic snapshot and protocol, offline, byte for byte except the generation timestamp.
