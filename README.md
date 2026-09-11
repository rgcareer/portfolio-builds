# portfolio-builds

Measurement pieces for Ryan Garver's portfolio (Track P). One package per piece. Every piece ships
a headline number, its cost, its failure modes, a decision log, and a reproducible run.

## The one rule

**Real numbers only.** Nothing here carries a fabricated, placeholder, or simulated number. A
headline sentence is rendered only from a committed `run-meta.json` by a generator that refuses to
print an unresolved value. Anything an LLM judged rather than a tool measured is labeled
`[SIMULATED]` with a confidence cap of 0.80 and never appears in a headline.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Vendored, tested primitives: SSRF-guarded fetch (timeout + byte cap), model policy (`claude-opus-5` banned at load), never-throws LLM gateway with a SQLite `calls` cost ledger and a per-run spend cap, canonical JSON, Wilson intervals, HMAC redaction, headline renderer. |
| `packages/onboarding-transfer-rate` | Piece 1. 50 official AI-tool quickstarts scored against each vendor's own stated first-success milestone. |
| `packages/failure-atlas` | Piece 2. Operation Hired's production telemetry mined into a failure taxonomy, human-intervention rate, and cost, from logs only. |
| `skillcheck/` | Piece 3 (flagship). Imported with history as a self-contained nested project; run its own `npm test` inside it. |
| `tests.json` | Append-only registry of required checks. `npm run gate` runs them and writes `evidence/`. |
| `PROGRESS.md` | Status board, decision log, send-status log, session log. Read this first when resuming. |

## Reproduce

Each package README states its exact reproduce command and the snapshot it runs against. The root
gate:

```bash
npm ci && npm run gate
```

## Cost

All LLM calls go through `packages/shared`'s gateway, which logs usage-derived cost per call and
stops at `PB_SPEND_CAP_USD` (default 0 = mock mode). Each package README prints its actual cost
from that ledger. Variable names are listed in `env.example`; the real env file is never read by
the build session.
