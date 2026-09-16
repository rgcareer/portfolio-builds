# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-09-15

### Added

- `SemanticCache`: an exact-hash tier (no embedding call on that path) plus a local MiniLM
  cosine-similarity tier, namespaced by tenant, model, system-prompt hash, and mock flag.
- `slotGuard`: a deterministic textual veto that runs after the similarity tier clears
  threshold, catching numeric, identifier, and negation mismatches that cosine similarity
  cannot structurally distinguish.
- `isCacheable`: a refusal policy that keeps tool use, streaming, explicitly time-sensitive or
  opted-out calls, empty input, time-sensitive-looking text, and detected PII out of the cache
  entirely.
- `cachedCallLlm`: a drop-in front for `callLlm` that checks both tiers before a real call and
  stores a successful result for next time, emitting a content-free `TrafficRecord` per call.
- A frozen 40-intent paraphrase set (`protocol/paraphrase-set.json`, 3 paraphrases and 3
  near-miss negatives per intent, 280 items total) and cache rules
  (`protocol/cache-rules.json`), hashed together before any embedding ran.
- `sweep`: a tau-grid sweep (0.70 to 0.99, step 0.01) producing hit rate and false-hit rate
  with 95% Wilson intervals at every threshold.
- CLI: `model fetch`, `embed`, `sweep`, `headline`, `repro`, `audit protocol-frozen`, `audit
  pii-sweep`, `audit readme-headline`, `audit embedding-audit`, `stats`, `lookup`, `purge`.
- `repro`, re-deriving `curve.json` and `run-meta.json` from committed embeddings offline and
  matching them bit for bit.

### Measured

- Embedded and swept the frozen paraphrase set with `Xenova/all-MiniLM-L6-v2` (fp32, mean
  pooling, normalized, 384 dims). At the shipped threshold (`tau = 0.90`): hit rate 61.7% (95%
  Wilson CI 52.7-69.9%, 74/120), false-hit rate 6.7% (CI 3.4-12.6%, 8/120). Embedding cost $0.
- `repro`, `audit protocol-frozen`, `audit pii-sweep`, and `audit embedding-audit` (10 seeded
  items, min cosine 0.9999999999998705) all pass against the committed run.
