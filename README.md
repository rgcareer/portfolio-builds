# portfolio-builds

Five small, production-shaped AI-infrastructure tools, each built to the same evidence standard: a
single headline number rendered from committed data, a 95% confidence interval on every rate, a
protocol frozen before the run, and a `repro` command that re-derives the result bit-for-bit
offline. If a number can't be reproduced from a committed file, it isn't in this repo.

Built by Ryan Garver (Smart Business AI LLC). MIT licensed.

## The one rule

**Real numbers only.** Nothing here carries a fabricated, placeholder, or simulated number. A
headline sentence is rendered only from a committed `run-meta.json` by a generator that refuses to
print an unresolved value. Anything an LLM judged rather than a tool measured is labeled
`[SIMULATED]` with a confidence cap of 0.80 and never appears in a headline.

## The packages

| Package | What it does | Docs |
|---|---|---|
| [`@rgcareer/llm-cost-autopilot`](packages/llm-cost-autopilot) | Prices your real Claude Code traffic against a no-cache counterfactual and reports cache savings with a session-level bootstrap interval. | [README](packages/llm-cost-autopilot/README.md) · [case study](packages/llm-cost-autopilot/case-study.md) |
| [`@rgcareer/semantic-cache`](packages/semantic-cache) | A local-embedding semantic cache measured for both hit rate and wrong-hit rate at its shipped similarity threshold, each with a Wilson interval. | [README](packages/semantic-cache/README.md) · [case study](packages/semantic-cache/case-study.md) |
| [`@rgcareer/model-regress`](packages/model-regress) | A paired golden-set detector that separates a real model or prompt regression from a model's own run-to-run noise (Newcombe interval + McNemar's exact test). | [README](packages/model-regress/README.md) · [case study](packages/model-regress/case-study.md) |
| [`@rgcareer/agent-forensics`](packages/agent-forensics) | Mines your own agent transcripts — content-free and HMAC-redacted by construction — for breakdown signatures and a tool-call error rate. | [README](packages/agent-forensics/README.md) · [case study](packages/agent-forensics/case-study.md) |
| [`@rgcareer/docmend`](packages/docmend) | Scans docs for drift (dead links, moved redirects, stale version pins, missing prerequisites) and writes machine-reverifiable fix proposals — evidence only, never applied. | [README](packages/docmend/README.md) · [case study](packages/docmend/case-study.md) |

Each package README's `## Result` is one sentence rendered by `renderHeadline` from that package's
committed `run-meta.json`. The numbers live in the data, not in the prose — including this one.

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
npm ci && npm run gate
```

`npm run gate` runs every check registered in `tests.json` and writes a timestamped record under
`evidence/`. Each package also ships its own `repro` command (see its README) that re-derives the
committed result offline, bit-for-bit.

## Cost

Every LLM call goes through `packages/shared`'s gateway, which logs usage-derived cost per call and
stops at `PB_SPEND_CAP_USD` (default `0` = mock mode). Every measurement in this repo cost $0 except
one disclosed model-comparison run, whose exact cost is stated in that package's README. Variable
names are listed in `env.example`; the real env file is never committed.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Smart Business AI LLC.
