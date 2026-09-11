# Onboarding Transfer Rate

Do official AI-tool quickstarts tell you what success looks like, and do their own instructions
hold up? Fifty official quickstart pages, selected by a pre-registered mechanical rule, scored
against each vendor's **own** stated first-success milestone and a frozen set of integrity checks
whose truth comes from outside the author (package registries, link status, syntax parsers).

## Result

Not yet measured. The headline sentence is rendered only from `data/run-meta.json` by
`npm run otr -- headline`; it refuses to print until the run exists. When it does, the sentence
is pasted here verbatim and an audit check keeps the two identical.

## What is measured (v1, $0)

| Layer | Question | Truth source | Tunable by the author? |
|---|---|---|---|
| **L0 milestone** | Does the page state, in its own words, what the reader will observe on success? | Frozen regex family over the page text (`protocol/checks.json`) | No: patterns frozen and hashed before the first fetch |
| **L0 time claim** | Does the page promise a time-to-first-success? (informational) | Frozen regex over title / H1 / first 1500 chars | No |
| **L1 package exists** | Does every package in an install command exist in npm / PyPI? | Registry JSON APIs | No |
| **L1 version drift** | Is a pinned version a major behind, or the package deprecated / yanked? | Registry JSON APIs | No |
| **L1 links** | Do the first 25 absolute links answer 2xx/3xx? | HTTP GET through the SSRF guard | No |
| **L1 prerequisite order** | Is every env var / CLI tool used in code mentioned in prose? | The page itself, mechanically | No: rule frozen |
| **L1 code parse** | Do fenced JS/TS and Python blocks parse? (never executed; fragments skipped) | TypeScript compiler, `python3 ast.parse` | No |
| **L1 auth wall** (stratum) | Does first success need an API key / account? | Frozen phrase list before the milestone line | No; never counted against the pass rate |

**L1 pass** = zero findings in `broken-command`, `version-drift`, `broken-link`, `missing-prerequisite`.
A proportion is never printed without its 95% Wilson interval. n is the achieved n, never padded.

## What is NOT measured

- Actual learner time-to-success. That needs L2: executing the vendor's steps on a clean ephemeral
  runner for the no-credential stratum. L2 is designed but gated on a public GitHub Actions repo
  (publishing under Ryan's name), so it runs only with his approval and is reported separately.
- Anything behind a paid credential.
- Pages that need a browser to render (excluded and counted as `render-blocked`, whose definition is
  "text under 500 characters or no fenced code block, and no raw-markdown fallback").
- Tools outside the five seed topics. Closed API vendors enter only through an SDK repository that
  carries a seed topic. That is the price of a rule I cannot tune.
- Any `[SIMULATED]` judgment. L3 (an LLM "fresh learner") exists as a design, is confidence-capped
  at 0.80, and never enters a headline. It has not been run.

## How the corpus is chosen (pre-registered; `protocol/corpus-rule.json`)

1. Five unauthenticated GitHub search queries (`topic:llm`, `topic:ai-agents`, `topic:mcp`,
   `topic:rag`, `topic:llm-framework`), 100 results each, sorted by stars. The raw responses are
   committed under `data/seed/` so the order is reproducible after star counts move.
2. Union, then order by stars descending and name ascending. Exclude archived repos, forks, and
   awesome-lists. One repository per owner.
3. Walk down the list. For each repository, find its official quickstart in a fixed probe order:
   a quickstart-phrased link on the homepage; well-known `/docs/quickstart`-style paths; the README
   section under a quickstart-phrased heading. Every skip is written to `data/exclusion-ledger.json`
   with its reason.
4. Stop at 50 snapshotted pages.

Protocol v1.1 amended the phrase regex (decoration tolerance) after a 5-page probe trial and before
any measurement; the amendment, its reason, and the re-seed are recorded in the file itself and in
the monorepo decision log (D-012).

## Reproduce

```bash
npm ci
npm run otr -- repro       # re-derives findings.json + run-meta.json from the committed snapshot and cache, network off
npm run otr -- headline    # renders the sentence from run-meta.json
```

To re-run from the network (drift becomes a finding): `seed --force`, `candidates`, `snapshot`,
`analyze` (live), then `repro`.

## Cost

LLM calls: none. The `calls` ledger total is $0.00. Network: five GitHub search requests, roughly
ten page fetches per candidate, registry lookups per package, one GET per checked link.

## Failure modes of this measurement

- The milestone regex family can miss a milestone phrased outside its patterns (undercount of L0),
  and can match a line that is not a milestone (overcount). Every hit cites its line and excerpt so
  a reader can audit the classification.
- Registry name extraction is regex-based; unusual install syntax is skipped, not guessed.
- Link status is a point-in-time GET; a transient failure at fetch time is a finding at analysis time
  because the cache is what is committed. One retry is made at fetch time.
- Prose-mention checks are literal: a page that shows a tool only in a screenshot reads as never
  mentioning it.
