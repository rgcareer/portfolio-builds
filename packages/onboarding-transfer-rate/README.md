# Onboarding Transfer Rate

Do official AI-tool quickstarts tell you what success looks like, and do their own instructions
hold up? Fifty official quickstart pages, selected by a pre-registered mechanical rule, scored
against each vendor's **own** stated first-success milestone and a frozen set of integrity checks
whose truth comes from outside the author (package registries, link status, syntax parsers).

## Result

> Of 50 official AI-tool quickstarts snapshotted 2026-09-11, 9 (18.0%, 95% Wilson CI 9.8-30.8%) state a verifiable first-success milestone; 3 of those 9 pass every pre-registered integrity check (33.3%, CI 12.1-64.6%).

Rendered by `npm run otr -- headline` from `data/run-meta.json` (protocol hash `3d7f68ea…` frozen at
commit `01b758d`, seeded 2026-09-11T05:49Z, LLM cost $0.00, 0 calls). An audit check keeps this
sentence and the generator's output identical. `npm run otr -- repro` re-derives every number from
the committed snapshot with the network off.

**Read the headline strictly.** "State a verifiable first-success milestone" means: a line matched
the frozen milestone pattern family. The hand audit below shows the family has both false positives
and false negatives, so the pre-registered 18.0% is the mechanical rate, not the truth; the audited
estimate is reported separately and is not the headline.

### What the 50 pages look like

| | count |
|---|---|
| Pages by probe: README section / well-known docs path / homepage link | 30 / 9 / 11 |
| Pages that need a credential before first success (stratum, never a defect) | 15 |
| Pages with a time-to-first-success claim ("in 5 minutes") | 7 |
| Candidates walked to reach 50 pages | 87 (37 excluded: no quickstart phrase 21, unusable page 15, fetch failed 1) |
| Candidate-stage exclusions before the walk | 64 (duplicate owner 35, archived 15, awesome-list 14) |

### Integrity findings (all 50 pages)

| Category | pages | findings | what it is |
|---|---|---|---|
| missing-prerequisite | 29 | 77 | a CLI tool or env var used in code is never mentioned in prose. Tools: curl 9, git 9, pip 4, make 2, npx 2, npm 2, python 2, uv 1. Env vars: 45, mostly API keys and endpoints (`OPENAI_API_KEY` 4, the rest once each) |
| broken-link | 17 | 37 | GET did not answer 2xx/3xx: 404 × 20, 403 × 11, 405 × 3, network × 3 |
| broken-command | 2 | 2 | one package "not found" and one Python block that does not parse (see artifacts) |
| version-drift | 1 | 1 | a pinned package whose latest registry release is deprecated |
| undefined-success | 41 | 41 | no line matches the milestone family (L0, not counted) |
| no-time-claim | 43 | 43 | informational |

### The nine milestone hits, hand-audited

The classification is mechanical; the verdict column is my reading of each line in context and is
published so a reader can disagree with it. It does not change the headline.

| repo | line | matched text (excerpt) | verdict |
|---|---|---|---|
| crewAIInc/crewAI | 93 | "You should see something like:" + output block | milestone |
| headroomlabs-ai/headroom | 150 | "Example output:" + output block | milestone |
| huggingface/transformers | 358 | "Congratulations, you just trained your first model with Transformers!" | milestone |
| hiyouga/LlamaFactory | 55 | "If you see `True` then you have successfully installed PyTorch with CUDA support." | milestone (sub-step) |
| JuliusBrussee/caveman | 80 | "You should get a confirmation that the mode is active." | milestone |
| langchain-ai/langchain | 804 | "…You can view example output in the next step." | weak: points to example output rather than stating it |
| code-yeongyu/oh-my-openagent | 61 | "That's it. The agent figures everything out: explores your codebase…" | weak: describes behaviour, not an observable signal |
| aaif-goose/goose | 152 | "…When you return to the goose desktop app, you're ready to begin your first session." | weak: end-of-setup, not an observation |
| D4Vinci/Scrapling | 319 | "- You've completed or read the Fetchers basics page…" | **false positive**: a prerequisite bullet matched "you've completed" |

Five clear, three weak, one false positive. Scrapling is also one of the three L1 passes, so the
"3 of 9" figure carries that false positive with it.

### Sensitivity of the L1 pass rate (post hoc, labelled, not the headline)

| variant | milestone pages passing | all pages passing |
|---|---|---|
| pre-registered: all counted categories | 3 / 9 | 15 / 50 |
| ignoring 403/405 link failures (likely bot-blocking of a non-browser client) | 3 / 9 | 18 / 50 |
| ignoring broken links entirely | 3 / 9 | 20 / 50 |
| ignoring missing-prerequisite entirely | 6 / 9 | 32 / 50 |
| registry and parse checks only | 8 / 9 | 47 / 50 |

The pass rate is driven by the prerequisite rule, which is strict by design: a page that runs
`curl` or exports `OPENAI_API_KEY` in a code block without ever naming it in prose fails. Whether
that is the right bar is a judgment the reader can make from the table; the rule was frozen before
the data existed.

### Known artifacts (disclosed, not patched after the fact)

- **Merged code tokens.** One page renders code lines as adjacent `<span>` elements with no newline;
  the text converter fused `npm install -g omniroute` with the next line's `added 1 package` into a
  fake package name, producing a false broken-command on a non-milestone page. The converter will be
  fixed in protocol v2; the committed text is left as analysed so the repro check stays exact.
- **A shell command in a `python` fence** (milvus) fails the Python parse check. The fence label is the
  vendor's; the check counted it as frozen.
- **Site navigation is part of the text.** The 25-link check on docs sites mostly exercises nav links.
- **403 responses** to a non-browser user agent are counted as broken per the frozen rule; 11 of 37
  link failures are 403s.

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
