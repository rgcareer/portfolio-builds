# model-regress

A paired golden-set regression detector for model or prompt migrations. It measures the
same-model noise floor before it calls anything a regression, and tracks cost and latency per
item so a quality win can't hide a cost regression.

## Result

On a 40-item deterministic extraction golden set (run 2026-09-16), claude-sonnet-5 passed 38/40 (95.0%, 95% Wilson CI 83.5-98.6%) and claude-haiku-4-5 passed 8/40 (20.0%, CI 10.5-34.8%); paired difference 75.0 pp (95% CI 57.5 to 85.8) against a same-model repeat disagreement of 4/40; cost per item $0.00260 vs $0.00076.

That sentence is the literal output of `node --import tsx src/cli.ts headline`, rendered from the
committed `data/run-meta.json`. Swapping Sonnet 5 for Haiku 4.5 on this extraction task is a real
75-point regression: the paired difference far exceeds the same-model noise floor of 4/40, so it
is signal, not run-to-run variation. The run cost $0.24 of real API calls (a $0.12 pilot that
caught an underspecified prompt is disclosed in the decision log and was withdrawn).

## The problem

Swapping a model or a prompt changes the pass rate on your eval set. Some of that change is
real. Some of it is the same model disagreeing with its own earlier output. Comparing two
single runs and reporting whichever number moved treats noise as signal.

model-regress runs three conditions against a frozen golden set: model A, model B, and a
repeat of model A. The A-vs-A-repeat pair measures how much a model disagrees with itself on
identical inputs. The A-vs-B paired difference only counts as a regression when its 95%
confidence interval excludes zero AND its magnitude exceeds the A-vs-A-repeat noise ceiling.
Otherwise the result is "no detectable regression at n," reported with the minimal detectable
effect at 80% power.

## What it measures

- **Exact-json paired pass**: canonical equality between the model's parsed JSON output and
  the golden item's expected object. This is the only headline-eligible assertion.
- **Cost and latency per item**, from the same gateway calls that produced the pass/fail data.
- **A same-model noise floor**, from the A-repeat condition, using Newcombe method 10 paired
  confidence intervals and McNemar's exact test on the discordant pairs.
- Everything else the assertion library can check (json-schema, contains, regex, cost/latency
  ceilings, an LLM rubric) is secondary and reported outside the headline.

Not measured: judge quality, tool use, long context, prompt variants, other tasks. See
`protocol/experiment.json`'s `not_measured` field.

## Headline

```
node --import tsx src/cli.ts headline
```

Renders the frozen `headline_template` from `protocol/experiment.json` against the committed
`data/run-meta.json`, through `renderHeadline` (`@portfolio-builds/shared`). `renderHeadline`
throws on any unresolved placeholder, `TBD`/`TODO`, `X%`, or non-finite value, so this
sentence is never hand-typed.

**Not yet measured.** No paired run has been committed for this package, so `data/run-meta.json`
does not exist and the headline is not renderable. Running the command above against this
checkout returns the following.

```
no run-meta.json with headline values yet; the headline is not renderable until a paired run produces it
```

## CLI

```
model-regress <command> [--json]
  golden gen [--seed N] [--n N] [--out path]   generate the deterministic golden set
  golden hash                                  print the protocol golden hash
  estimate --all                               pre-call cost estimate per condition
  run --condition A [--model M] [--mock]       run one condition over the golden set
  compare [--a A --b B --noise A-repeat]        build the paired comparison + run-meta
  headline                                     render the headline from run-meta.json
  ci [--a --b --noise --max-drop-pp --max-cost-increase-pct]   exit-code gate
  power --n N --discordant R [--power P]        MDE / required-n calculator
  repro                                        re-derive comparison.json + run-meta.json
```

There is no `report` command; `headline` and `compare --json` are the machine-readable
surfaces. Every command that touches the network only does so through `callLlm`, which stays
in mock mode (`$0`, no real call) unless `PB_SPEND_CAP_USD` is raised.

Sample output from this checkout, pasted verbatim:

```
$ node --import tsx src/cli.ts golden hash
46d13b8d6becae88f9ed53d865412e9d35bf20c0d9d0b41a6c709ae7caa4eb08

$ node --import tsx src/cli.ts estimate --all
A (claude-sonnet-5): expected $0.0869, ceiling $0.1692, 40 calls
B (claude-haiku-4-5): expected $0.0434, ceiling $0.0846, 40 calls
A-repeat (claude-sonnet-5): expected $0.0869, ceiling $0.1692, 40 calls
TOTAL: expected $0.2172, ceiling $0.4229, 120 calls (cap $3)

$ node --import tsx src/cli.ts power --n 40 --discordant 0.2
MDE at n=40, discordant rate 0.2, power 0.8: 19.81 pp
  to detect 5 pp → need n=628
  to detect 10 pp → need n=157
  to detect 15 pp → need n=70

$ node --import tsx src/cli.ts repro
repro: no committed run yet — nothing to re-derive (a no-op before any run)
```

## Protocol

`protocol/experiment.json` is frozen before any data collection and hashed (`golden hash`
covers both the experiment file and the deterministic golden generator). The task is a
receipt-extraction contract: return exactly one JSON object with `id`, `date`, `total_cents`,
`paid`, `status`, `items`, no prose. Conditions are A (claude-sonnet-5), B (claude-haiku-4-5),
and A-repeat (claude-sonnet-5 again, for the noise floor). A run is auditable end to end:
`run-state.json` records the protocol hash, the golden hash, and the commit at freeze time,
and `repro` re-derives `comparison.json` and `run-meta.json` bit-for-bit from the committed
runs (ignoring only `generatedAt`).

## Decision rule

From `protocol/experiment.json`:

> 'regression' only if the exact-json paired-difference 95% CI excludes 0 AND |diff| exceeds
> the upper bound of the A-vs-A-repeat paired-difference CI; else 'no detectable regression at
> n=40' reported with the minimal detectable effect at 80% power. A cost-per-item increase
> beyond max_cost_increase_pct fails `ci` regardless of pass rate.

The `max_drop_pp` and `max_cost_increase_pct` thresholds are set in `protocol/experiment.json`
and can be overridden per invocation with `ci --max-drop-pp` / `ci --max-cost-increase-pct`.

## Status

Not yet measured: no golden-set run has been executed against this protocol yet. 74 tests
pass (`npx vitest run packages/model-regress`) and the package type-checks clean
(`npx tsc --noEmit`), but those numbers describe the test suite, not a measurement of model
behavior; they are not headline claims.

## Install

```
npm install @rgcareer/model-regress
```

## License

MIT
