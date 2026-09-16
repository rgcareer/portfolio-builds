---
slug: semantic-cache
title: Semantic Cache
tagline: A cache in front of LLM calls that measures its own hit rate and false-hit rate against a labelled near-miss set, instead of shipping a threshold on faith.
role: Design + build
year: '2026'
status: built and measured
stack: [TypeScript, Node.js, citty, MiniLM (Xenova/all-MiniLM-L6-v2), Vitest]
metrics:
  - label: Hit rate at tau=0.90
    value: 61.7% (95% CI 52.7-69.9%)
  - label: False-hit rate at tau=0.90
    value: 6.7% (95% CI 3.4-12.6%)
  - label: Embedding cost
    value: $0
tags: [llm-infra, caching, embeddings, evaluation]
links:
  repo: https://github.com/rgcareer/semcache
metrics_source:
  Hit rate at tau=0.90: data/run-meta.json#hitPct (Wilson interval at hitLo/hitHi)
  False-hit rate at tau=0.90: data/run-meta.json#fpPct (Wilson interval at fpLo/fpHi)
  Embedding cost: data/run-meta.json#costUsd
---

## Lead

Every semantic cache I'd read about picks a similarity threshold and moves on. Nobody publishes
what that threshold actually costs them in wrong answers. I wanted to know, for my own setup,
exactly how often "close enough" embeddings serve the right cached response and how often they
serve the wrong one, at the threshold I'm actually shipping.

## Problem

A semantic cache in front of an LLM sits on a real tradeoff. Set the similarity threshold low
and you catch more paraphrases, saving more calls. Set it too low and "cancel order #4471" comes
back as a hit for "confirm order #4471," or "please cancel order #4471" matches "please do not
cancel order #4471." Those are the two ways this fails, and most write-ups I found reported one
side of the tradeoff (hit rate) without the other (how often it hits on something that means the
opposite).

## Approach

I wrote 40 support-style intents by hand (confirm an order, cancel a subscription, check a
status, and so on), each with 3 genuine paraphrases and 3 near-miss negatives built by one of
three fixed rules: swap the slot value, swap the entity, or negate the verb. That's 280
hand-written queries, frozen in `protocol/paraphrase-set.json` before I embedded anything.

Every query gets embedded once with a local MiniLM model, so the whole sweep costs $0 and never
leaves my machine. The cache itself runs two tiers: an exact-hash check first, then a cosine
similarity search against everything live in the same namespace. A candidate that clears the
similarity threshold still passes through a slot guard, a plain regex check for numeric,
identifier, or negation mismatches, before it counts as a hit. That guard exists because
embeddings alone put "confirm order #4471" and "confirm order #8822" almost on top of each
other; nothing about cosine similarity distinguishes two order numbers that differ by four
digits.

I swept the threshold from 0.70 to 0.99 and picked 0.90 to ship, then measured hit rate and
false-hit rate at that point with 95% Wilson intervals, not just point estimates.

## The honesty feature

The headline sentence in the README is never typed by hand. It comes from
`node --import tsx src/cli.ts headline`, which reads a committed `run-meta.json` and renders it
through `renderHeadline`, a function that throws on any unresolved placeholder, `TBD`, or
non-finite value. An audit checks the README and the generator's output stay byte-identical.
That's the same discipline whether the run says "not yet measured" (as it does for two of the
other packages in this build) or says something real, like it does here:

```
$ node --import tsx src/cli.ts headline
headline: On 280 hand-written queries (40 intents, each with 3 paraphrases and 3 near-miss negatives), the local MiniLM cache at its shipped threshold 0.90 served 74 of 120 paraphrases from cache (61.7%, 95% Wilson CI 52.7-69.9%) and wrongly served 8 of 120 near-misses (6.7%, CI 3.4-12.6%); embeddings cost $0.
```

The paraphrase set is mine, hand-written, not sampled from real traffic, so 61.7%/6.7% describes
this labelled set at this threshold with this embedding model, not a universal number. I'd
rather publish that scoped claim with its interval than a rounder number I can't stand behind.

## How I verified it

- `npx vitest run packages/semantic-cache` and `npx tsc --noEmit` both pass before any claim
  about this package is made.
- `node --import tsx src/cli.ts repro` re-derives `curve.json` and `run-meta.json` from the
  committed `data/embeddings.json` and the frozen protocol, entirely offline, and diffs the
  result against what's committed byte for byte. Run against this checkout: `{"match":true,
  "curveMatch":true,"runMetaMatch":true}`.
- `audit protocol-frozen` confirms the paraphrase set and cache rules haven't changed since the
  embeddings were produced, so the threshold wasn't picked after seeing where the numbers landed.
- `audit embedding-audit` re-embeds 10 seeded items with the same local model and checks cosine
  similarity to the committed vectors is at least 0.9999. Run against this checkout: minimum
  cosine 0.9999999999998705 across 10 samples.
- `audit pii-sweep` scans every committed protocol and data file for PII shapes before it's
  allowed to be committed at all.
