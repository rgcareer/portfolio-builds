# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-09-15

### Added

- `RunRecord` model and Claude Code / Agent Trace v1 adapters, redacted by construction: tool
  inputs, outputs, and prompt text never enter a record.
- Eleven pre-registered detectors (`LOOP`, `RETRY`, `APIERR`, `REFUSAL`, `DANGLE`, `HOOKERR`,
  `TIMEOUT`, `TOOLERR`, `DENIAL`, `INTERRUPT`, `COMPACT`) frozen in `protocol/detectors.json`,
  hashed at load time.
- MAST category mapping in `protocol/taxonomy.json`, labeled explicitly as a convenience with
  no prevalence claim.
- Timeline builder, blame-span selection, and minimal-repro slicing per session.
- `analyzeRecords` aggregation with Wilson intervals, plus `headlineFromRunMeta` so the
  headline sentence is always rendered from committed data, never hand-typed.
- CLI: `ingest`, `analyze`, `headline`, `repro`, `report`, `detect`, `convert`, `audit`, `show`.
- `audit` command and `redactionAudit` / `auditTree` for sweeping committed data for redaction
  violations, plus a `protocol-frozen` check that fails if the protocol changed after ingest.
- `reproduce` command that re-derives findings and run-meta from committed records offline.

### Not yet done

- No transcripts ingested yet. `data/records` is empty and `data/run-meta.json` does not exist,
  so the headline and every reported number are "Not yet measured."
