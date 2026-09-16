# evalcard — a no-code report card for your AI assistant

**Write test cases in plain English. Run them against Claude. Get a report card
and a one-page "is this safe to ship?" brief.** No eval framework to learn, no
code to write — if you can fill in a spreadsheet, you can test an AI assistant.

```bash
# 1. Try the bundled example right now — no API key needed (uses fixtures):
npx tsx src/cli.ts run examples/support-bot/cases.csv --mock

# 2. Run your own cases against the live model:
export ANTHROPIC_API_KEY=sk-ant-...        # your key, never committed
npx tsx src/cli.ts run my-cases.csv
```

You get three things: a **terminal summary**, an **HTML report card**
(`report.html` — open it in any browser), and **`evals-brief.md`** — a plain-English
verdict (**ship / fix-first / don't-ship**) an exec can read in 30 seconds.

![report card screenshot](docs/evidence/report-card-screenshot.png)

---

## Why this exists

Most people who *deploy* an AI assistant can't *evaluate* one. Eval tooling
assumes you write Python and think in metrics. evalcard is for the operator — the
person who owns the support bot but not the codebase. You describe what a good
answer looks like in words; evalcard turns that into pass/fail checks, an
LLM-judged rubric, and a confidence score you can trust.

## How to write a test case

A test case is one row of a CSV (or one item of a YAML file). Columns:

| Column | Meaning |
| --- | --- |
| `input` | What the user says to the assistant (required). |
| `expected_behavior` | Plain-English description of a good answer (shown in reports). |
| `must_include` | Phrases the answer **must** contain. Separate multiple with `\|`. |
| `must_not_include` | Phrases the answer **must not** contain. |
| `must_match` | Regex patterns the answer must match (optional, for the technical). |
| `rubric` | Plain-language yes/no checks graded by an LLM judge. Separate with `\|`. |

Example row:

```csv
id,input,expected_behavior,must_include,must_not_include,rubric
refund,"Can I get a refund?","Explains the refund policy politely",refund,,Is the tone polite? | Does it state the policy?
```

An optional `system.txt` next to your cases file becomes the system prompt for the
assistant under test. See [`examples/support-bot/`](examples/support-bot/) for a
complete, runnable example (a contractor-business FAQ bot).

## How grading works

Each case is graded two ways, then blended into a **confidence score**:

1. **Deterministic checks** — `must_include` / `must_not_include` / `must_match`.
   Objective, fast, no AI involved.
2. **LLM judge** — grades your plain-language `rubric`, returning per-criterion
   pass/fail **with a rationale** so you can see *why*.

**The honesty feature:** the judge runs the *same model family* as the assistant
it's grading, so it is **not an independent reviewer**. Every judge result is
labeled **`[SIMULATED]`**, and per-case confidence is **capped at 0.80** because a
same-model judge can't earn full trust. (This idea is ported from the Victoria 4.0
methodology's `[SIMULATED]` / `[EXTERNAL]` independence rule — a simulated checker
never exceeds 0.80.) The report always states that a **human owns the final ship
decision**. evalcard advises; it does not authorize.

## Commands

```bash
evalcard run <cases.csv|cases.yaml> [options]

  -m, --model <id>          model for the assistant under test (default: claude-sonnet-5)
      --mock                use fixtures instead of the live API (no key needed)
  -s, --system <str|path>   system prompt for the assistant under test
  -o, --out <dir>           where to write report.html + evals-brief.md (default: evalcard-out)
      --runs <path>         history store for regression deltas (default: runs.json)
      --fixtures <path>     fixtures.json map for --mock mode
```

Runs are recorded in `runs.json`, so every report shows a **regression delta** vs
the previous run of the same file — which cases newly pass, which newly fail.

## Install / run

```bash
npm install
npm test                    # unit tests, all in mock mode (no key needed)
npx tsx src/cli.ts run examples/support-bot/cases.csv --mock
npm run build               # compile to dist/ and use the `evalcard` bin
```

Requires Node 20+. The API key is read from `process.env.ANTHROPIC_API_KEY` only —
copy `.env.example` to `.env` for local use. **Never commit your real key.**

## What this is NOT

evalcard is deliberately small. To keep it honest and usable, it does **not** do:

- **No web dashboard or server.** It's a CLI that writes an HTML file you open locally.
- **No multi-provider matrix.** It tests one Anthropic model per run — not a grid of vendors.
- **No CI integration.** No GitHub Action, no pipeline plugin. (It does exit non-zero
  on a "don't-ship" verdict, so you *could* wire it up yourself — but that's not shipped.)
- **No prompt management.** It doesn't version, store, or optimize your prompts.
- **No accounts, users, or auth.** Nothing to log into.
- **No database beyond `runs.json`.** A single local JSON file is the entire datastore.
- **Not an independent audit.** The judge is same-model `[SIMULATED]`; a human still
  signs off. Confidence is capped accordingly, on purpose.

If you need any of the above, evalcard is the wrong tool — and that's fine.

## License

MIT. Built by Ryan / Get Smart AI.
