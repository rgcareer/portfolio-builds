# portfolio-builds

[![CI](https://github.com/rgcareer/portfolio-builds/actions/workflows/ci.yml/badge.svg)](https://github.com/rgcareer/portfolio-builds/actions/workflows/ci.yml)

Five small, production-shaped AI-infrastructure tools, each built to the same evidence standard: a
single headline number rendered from committed data, a 95% confidence interval on every rate, a
protocol frozen before the run, and a `repro` command that re-derives the result bit-for-bit
offline. If a number can't be reproduced from a committed file, it isn't in this repo.

Built by Ryan Garver (Smart Business AI LLC) — more at [getsmartai.ai](https://getsmartai.ai).
MIT licensed.

## The one rule

**Real numbers only.** Nothing here carries a fabricated, placeholder, or simulated number. A
headline sentence is rendered only from a committed `run-meta.json` by a generator that refuses to
print an unresolved value. Anything an LLM judged rather than a tool measured is labeled
`[SIMULATED]` with a confidence cap of 0.80 and never appears in a headline.

## Results

Every line below is rendered by [`scripts/render-root-results.mjs`](scripts/render-root-results.mjs)
from the same committed `run-meta.json` files the per-package audits check — a required gate check
fails if this list ever drifts from the data.

<!-- results:begin — rendered by scripts/render-root-results.mjs; do not edit by hand -->
- **[llm-cost-autopilot](packages/llm-cost-autopilot)** — Across 10703 real Claude API calls in 85 of my own Claude Code sessions (2026-08-16 to 2026-09-15), prompt caching cut the bill from $25863.40 (every input token at the fresh rate) to $3959.81 actually billed at list rates: 84.7% saved (session-level bootstrap 95% CI 83.2-86.0%); 10669 of 10703 calls (99.7%, 95% Wilson CI 99.6-99.8%) read from cache.
- **[semantic-cache](packages/semantic-cache)** — On 280 hand-written queries (40 intents, each with 3 paraphrases and 3 near-miss negatives), the local MiniLM cache at its shipped threshold 0.90 served 74 of 120 paraphrases from cache (61.7%, 95% Wilson CI 52.7-69.9%) and wrongly served 8 of 120 near-misses (6.7%, CI 3.4-12.6%); embeddings cost $0.
- **[model-regress](packages/model-regress)** — On a 40-item deterministic extraction golden set (run 2026-09-16), claude-sonnet-5 passed 38/40 (95.0%, 95% Wilson CI 83.5-98.6%) and claude-haiku-4-5 passed 8/40 (20.0%, CI 10.5-34.8%); paired difference 75.0 pp (95% CI 57.5 to 85.8) against a same-model repeat disagreement of 4/40; cost per item $0.00260 vs $0.00076.
- **[agent-forensics](packages/agent-forensics)** — Across 189 of my own Claude Code sessions (2026-07-20 to 2026-09-16; 36480 tool calls), 96 (50.8%, 95% Wilson CI 43.7-57.8%) contain at least one pre-registered breakdown signature; the most frequent is TIMEOUT (62 sessions); 896 tool calls (2.5%, CI 2.3-2.6%) returned an error.
- **[docmend](packages/docmend)** — Across 70 documentation pages (8 of Ryan's own: 4 public repos and 12 getsmartai.ai page(s); 50 external quickstarts snapshotted 2026-09-11) with 748 links, 267 code blocks and 5 version pins, 268 drift findings; 86 fixes proposed, 25 (29.1%, 95% Wilson CI 20.5-39.4%) pass independent re-verification.
  (Corpus composition per its run-meta: 8 own-repo pages across 4 public repos + 12 getsmartai.ai pages + 50 external quickstarts = 70.)
- **[onboarding-transfer-rate](packages/onboarding-transfer-rate)** — Of 50 official AI-tool quickstarts snapshotted 2026-09-11, 9 (18.0%, 95% Wilson CI 9.8-30.8%) state a verifiable first-success milestone; 3 of those 9 pass every pre-registered integrity check (33.3%, CI 12.1-64.6%).
<!-- results:end -->

## The packages

| Package | What it does | Docs |
|---|---|---|
| [`@rgcareer/llm-cost-autopilot`](packages/llm-cost-autopilot) | Prices your real Claude Code traffic against a no-cache counterfactual and reports cache savings with a session-level bootstrap interval. | [README](packages/llm-cost-autopilot/README.md) · [case study](packages/llm-cost-autopilot/case-study.md) |
| [`@rgcareer/semantic-cache`](packages/semantic-cache) | A local-embedding semantic cache measured for both hit rate and wrong-hit rate at its shipped similarity threshold, each with a Wilson interval. | [README](packages/semantic-cache/README.md) · [case study](packages/semantic-cache/case-study.md) |
| [`@rgcareer/model-regress`](packages/model-regress) | A paired golden-set detector that separates a real model or prompt regression from a model's own run-to-run noise (Newcombe interval + McNemar's exact test). | [README](packages/model-regress/README.md) · [case study](packages/model-regress/case-study.md) |
| [`@rgcareer/agent-forensics`](packages/agent-forensics) | Mines your own agent transcripts — content-free and HMAC-redacted by construction — for breakdown signatures and a tool-call error rate. | [README](packages/agent-forensics/README.md) · [case study](packages/agent-forensics/case-study.md) |
| [`@rgcareer/docmend`](packages/docmend) | Scans docs for drift (dead links, moved redirects, stale version pins, missing prerequisites) and writes machine-reverifiable fix proposals — evidence only, never applied. | [README](packages/docmend/README.md) · [case study](packages/docmend/case-study.md) |

Each package README's `## Result` is one sentence rendered by `renderHeadline` from that package's
committed `run-meta.json`, and the Results list above is re-rendered from the same generators. The
numbers live in the data, not in the prose.

## How this was built

I designed the specs, the pre-registered protocols, and the gates; AI agents did most of the
typing; nothing counted as done until the gate re-derived it. The workflow itself is committed:

- Each package started as a written spec ([docs/specs](docs/specs)) and a frozen, hashed protocol
  (`packages/*/protocol/`) committed **before** any data was collected. Amendments are documented
  decisions made before measurement, never after seeing a result.
- Builder agents wrote each package tests-first from its spec, orchestrated by the workflow
  scripts in [`.claude/workflows`](.claude/workflows) with the agent roles in
  [`.claude/agents`](.claude/agents). The commit history carries the co-author lines.
- Every "done" claim has to survive [`tests.json`](tests.json) — an append-only registry of
  required checks (unit suites, protocol-freeze audits, PII sweeps, README-headline audits, and
  bit-for-bit `repro` re-derivations) run by `npm run gate` locally and in CI. Checks are added,
  never removed or weakened to make the gate pass.
- A fresh-context reviewer agent that didn't write the code reviewed each package against its
  spec before acceptance; material findings got one fix pass and a re-run of the gate.
- The judgment calls that shaped the results — what was frozen, what was amended, what was
  disclosed instead of patched — are in [DECISIONS.md](DECISIONS.md).

## Also in this repo

- **`packages/shared`** — the tested primitives every package reuses: an SSRF-guarded fetch (per-hop
  redirect re-check, timeout, byte cap), a model policy that bans `claude-opus-5` at load, a
  never-throws LLM gateway with a SQLite cost ledger and a per-run spend cap, canonical JSON, Wilson
  intervals, and HMAC redaction.
- **`packages/onboarding-transfer-rate`** — an earlier piece: 50 official AI-tool quickstarts scored
  against each vendor's own stated first-success milestone.
- **`packages/failure-atlas`** — a pre-registered failure-taxonomy protocol (extraction not yet run).
- **`skillcheck/`** — a larger nested project, imported with its own history; run its `npm test`
  inside the directory.

## Reproduce

```bash
npm ci
npm --prefix skillcheck ci   # the nested skillcheck project installs its own dependencies
npx tsc --noEmit             # whole-repo typecheck
npm run gate                 # every check registered in tests.json
```

First-run notes: the semantic-cache suite downloads a local MiniLM embedding model (~90 MB) into a
cache the first time it runs, and the gate runs its suites serially for determinism — expect a few
minutes on CI-class hardware, longer on a busy laptop. `npm run gate` writes a timestamped record of
every check under `evidence/`. Each package also ships its own `repro` command (see its README) that
re-derives the committed result offline, bit-for-bit. CI runs this exact sequence on every push.

## Cost

Every LLM call goes through `packages/shared`'s gateway, which logs usage-derived cost per call and
stops at `PB_SPEND_CAP_USD` (default `0` = mock mode). Every measurement in this repo cost $0 except
one disclosed model-comparison run, whose exact cost is stated in that package's README. Variable
names are listed in `env.example`; the real env file is never committed.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Smart Business AI LLC.
