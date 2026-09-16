---
name: portfolio-builds-conventions
description: House rules for the portfolio-builds five-app build (real numbers only, gateway/ledger/spend cap, tests.json append-only, headline renderer, [SIMULATED] cap, HMAC redaction, protocol freeze + repro, reserved files, operational gotchas). Load for any build, test, audit, or docs task in this repo.
---

# portfolio-builds conventions

These are the non-negotiable house rules for this repo — read them before building, testing,
auditing, or documenting anything here:

- **Real numbers only.** Headlines render solely through `renderHeadline` from a committed
  `run-meta.json`; every proportion carries a 95% Wilson interval; LLM judgments are `[SIMULATED]`,
  capped at 0.80 confidence, and never in a headline. Never hand-type a portfolio-facing number.
- **LLM calls** go through `callLlm` (never throws; ledgered; `PB_SPEND_CAP_USD` 0 = mock). Tests
  always pass a mock responder. `claude-opus-5` is banned.
- **Determinism**: randomness only via `mulberry32`/`seededSample`; canonical JSON via `stableJson`.
  Protocols under `protocol/*.json` are frozen and hashed before data collection; a `repro` command
  re-derives published outputs bit-for-bit offline.
- **Privacy**: committed data passes `assertNoPii`; identifiers are HMAC-tokenized with
  `makeTokenizer(requireSalt())`; raw prompts/paths/ids are never committed.
- **Tests first**; `npx vitest run packages/<app>` and `npx tsc --noEmit` yourself; never run the
  gate or edit `tests.json` (main session only).
- **Reserved files** (never touch): `tests.json`, `package-lock.json`, root `package.json`,
  `PROGRESS.md`, `evidence/`, other packages, `~/.claude/`, any `.env`.
- **Hard stops**: no push, publish, spend beyond a named cap, cross-project edits, patch application,
  agent scheduling, `rm -rf`, or `npm install`.
- **Operational**: never put an env-file name or `process.env` in a Bash command (guard hook blocks
  it); run TS via `node --import tsx`; one egress override per fetch/download step.
