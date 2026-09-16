# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-09-15

### Added
- Deterministic golden-set generator (`golden gen`/`golden hash`), seeded via `mulberry32`, for
  a receipt-extraction JSON task (40 items at the frozen protocol default).
- Assertion library (`json-parse`, `json-schema`, `exact-json`, `contains`, `regex`,
  `cost-usd-max`, `latency-ms-max`, `rubric`); `exact-json` is the only headline-eligible
  assertion, and `rubric` is opt-in, `[SIMULATED]`, and capped at 0.80 confidence.
- Condition runner (`run`) over the shared LLM gateway, recording per-item cost, latency, and
  pass/fail, with spend-cap skips disclosed rather than padded into the denominator.
- Paired comparison (`compare`) computing Newcombe method 10 paired-difference confidence
  intervals and McNemar's exact test against a same-model noise floor (A-repeat).
- Decision rule: a regression requires the paired-difference CI to exclude 0 AND its magnitude
  to exceed the A-vs-A-repeat noise ceiling; otherwise "no detectable regression at n," with
  the minimal detectable effect at 80% power.
- `ci` exit-code gate with configurable max-drop-pp and max-cost-increase-pct thresholds.
- `power` command for minimum-detectable-effect and required-n calculations.
- `repro` command that re-derives `comparison.json` and `run-meta.json` bit-for-bit from
  committed run files, ignoring only `generatedAt`.
- Protocol freeze and hashing (`protocol/experiment.json` + the deterministic golden
  generator), with `run-state.json` recording the frozen hash and commit.
- PII sweep and README-headline audits (`audits.ts`), wired into the shared test gate.
- 74 tests across 11 files; `npx tsc --noEmit` clean.

### Status
The paired run against the frozen protocol is committed: `data/run-meta.json` renders the
headline result (see the README `## Result`), and `repro` re-derives `comparison.json` and
`run-meta.json` bit-for-bit. This release ships the measurement tool and that measurement.
