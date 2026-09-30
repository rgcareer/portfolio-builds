# failure-atlas

A pre-registered protocol for mining a production agent system's telemetry — read-only, via
SQLite's `immutable=1` URI — into a mechanically derived failure taxonomy, a human-correction
rate, and instrumented cost lower bounds.

## Result

Not yet measured.

The protocol ([`protocol/extract-spec.json`](protocol/extract-spec.json)) is committed and
frozen, but extraction has not been run, so this package carries no numbers. Per this repo's
[one rule](../../README.md#the-one-rule), a result appears here only when a committed
`run-meta.json` exists for a generator to render it from.

## What is committed today

- The frozen extract spec: which tables and columns are pulled, what provenance is recorded
  (database hash and byte size, per-table row counts, schema hashes), and the anonymization
  rules the snapshot must pass before it can be committed.
- A tested normalizer ([`src/normalize.ts`](src/normalize.ts)) that canonicalizes raw telemetry
  rows ahead of taxonomy work.

## License

MIT, as part of [portfolio-builds](../../README.md).
