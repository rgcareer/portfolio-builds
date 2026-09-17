# Security

## Supported versions

0.1.x is the only released line. Security fixes land on the latest release.

## Scope

model-regress runs a golden set of receipt-extraction prompts through the shared LLM gateway
and compares pass rates across model conditions. It does not accept or process arbitrary
user-uploaded documents; the golden set is generated deterministically from a frozen protocol
and a seed (`mulberry32`), not sourced from live user data.

## Network and spend

- Every model call goes through `callLlm` (`@portfolio-builds/shared`). It never throws and
  reports `{content|null, error|null, usage, costUsd, mock}`.
- `PB_SPEND_CAP_USD` defaults to 0, which is mock mode: no network call happens, no cost is
  incurred. A real call requires the cap to be raised explicitly.
- `--mock` on the `run` command forces the offline path regardless of the cap, using a
  responder that answers each prompt with that item's exact expected JSON, which is useful for
  testing the pipeline without spending anything.
- Estimated cost before any run is available via `estimate --all`, which reports both an
  expected cost and a hard ceiling per condition, computed from the same pricing table the
  gateway enforces.
- A spend-cap refusal mid-run marks that item and every remaining item `skipped: 'spend-cap'`.
  The achieved n is what completed; skips are counted and disclosed, never padded into the
  denominator.

## Data handling

- The golden set is synthetic and deterministic; it contains no real user data, transcripts,
  or identifiers.
- `assertNoPii` and a dedicated `piiSweep` audit (`audits.ts`) scan every file under `golden/`
  and `data/` for PII or secrets before it can be committed.
- The frozen model list is `claude-sonnet-5`, `claude-haiku-4-5`, and `claude-opus-4-8` for
  cost-table purposes; `claude-opus-5` is banned everywhere by a load-time guard in the shared
  package.

## Reporting a vulnerability

Open an issue at https://github.com/rgcareer/portfolio-builds/issues, or email the maintainer
listed in `package.json`. Please do not include real credentials, API keys, or personal data
in a report; describe the issue and, if needed, share a redacted reproduction.
