# Decision log (curated)

The judgment calls that shaped this repo, curated from the project's working decision log.
Numbering is preserved so package docs can cite entries; internal-only entries (scheduling,
session logistics) are omitted. Dates are when the call was made.

## Evidence discipline

- **D-011** (2026-09-11) — Every measured piece pre-registers its protocol: the corpus rule and
  check set are committed and hashed **before** the first fetch. `run-meta.json` records the hash
  and the protocol commit, and a test fails if the protocol changes after seeding.
- **D-012** (2026-09-11) — Protocol amendments happen before measurement or not at all. The
  quickstart selection regex was loosened (to tolerate decorated headings like "🚀 Quick Start")
  only after a 5-page probe trial, with the trial pages deleted and the corpus re-seeded, so the
  amended protocol still predates every measured page.
- **D-013** (2026-09-11) — The headline stays exactly what the pre-registered protocol produced
  (9/50 quickstarts stating a milestone), even though a post-hoc hand audit suggested friendlier
  readings. The hand audit and a blind LLM rater pass are published as labeled calibration, never
  substituted into the headline.
- **D-014** (2026-09-11) — A text-extraction defect found *after* analysis (adjacent code spans
  fused, causing one false positive on a non-milestone page) is disclosed in the docs, not
  patched: re-deriving committed text after seeing results would let the result shape the data.
  The fix waits for protocol v2.
- **D-024** (2026-09-16) — The model-regress pilot showed condition A scoring 0/40: valid JSON,
  wrong key names — the frozen prompt named the top-level schema but not the item sub-schema, so
  the task was impossible as specified. The prompt was amended to state the full schema, the
  pilot run was withdrawn (published nowhere), the protocol was re-frozen, and only then was the
  comparison measured. A degenerate 0/40 was not allowed to masquerade as a 95-point regression.

## Engineering

- **D-004** (2026-09-10) — The nested skillcheck project stays self-contained; shared primitives
  are vendored by copy with provenance headers rather than cross-imported, so each project's
  tests keep passing without reaching outside its own tree.
- **D-005** (2026-09-10) — The cost ledger uses Node's built-in `node:sqlite`. No native module,
  nothing to compile, one less supply-chain surface.
- **D-021** (2026-09-15) — docmend copies the frozen earlier piece's parsers with a provenance
  header naming the source commit and a drift-guard test, instead of importing a package whose
  results are frozen (see D-014: frozen means frozen).
- **D-022** (2026-09-15) — A price-table row was corrected from $3/$15 to the vendor-verified
  $2/$10 with the source cited in a comment and the test updated — a verified correction, with
  the verification recorded, not a test weakened to pass.
- **D-023** (2026-09-15) — New dependencies are named, versioned, and approved before install
  (tsup, citty, @huggingface/transformers), and current upstream facts are re-verified on the
  day (SDK major version, `node:sqlite` flag status on Node 24) rather than assumed.
- **D-025** (2026-09-16) — The whole-suite gate runs test files serially with a long timeout:
  the suites share fixed data/SQLite paths and one loads an ONNX embedding model, and a gate
  that flakes teaches people to re-run until green. Determinism beats speed here.

## AI-assisted build

- **D-003 / D-019** (2026-09-10/15) — LLM spend defaults to $0 (mock mode). Real spend happens
  only in named steps with a mock-run estimate shown first and a per-command cap that returns to
  0 afterward. Total real spend for every measurement in this repo: $0.36, disclosed in the one
  package that spent it.
- **D-020** (2026-09-15) — The five packages were built by agents from written specs, tests
  first: routine builds on a mid-tier model, judgment seats (adversarial review, audits) on a
  stronger one, orchestrated by the committed workflow scripts in `.claude/workflows`. Reserved
  files (`tests.json`, the lockfile, evidence records) stay main-session-only so no builder can
  touch its own scoreboard.

## Publishing

- **D-026** (2026-09-16) — Before the repo went public, a dedicated audit session ran a
  multi-agent security/correctness/completeness review and a **full git-history** secret and PII
  scan (a clean working tree says nothing about history). Findings — a local absolute path and
  internal working files — were purged with `git filter-repo`, and every provenance commit SHA
  recorded inside committed run data was remapped to its rewritten value, then the gate was
  re-run. The remap commits are in the history; the history rewrite is not a secret.
