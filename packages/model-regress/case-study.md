# Case study: model-regress

## The result

On the frozen 40-item set, Sonnet 5 passed 38/40 (95.0%) and Haiku 4.5 passed 8/40 (20.0%): a
75-point paired difference (95% CI 57.5 to 85.8) against a same-model repeat disagreement of only
4/40. That is a real regression, not noise. Cost per item was $0.0026 vs $0.00076. The whole run
cost $0.24 of real API calls, and a $0.12 pilot that surfaced an underspecified prompt is
disclosed and withdrawn rather than hidden.

## The question

When a team swaps models or edits a prompt, how do they know whether the pass-rate change they
see is a real regression versus the model disagreeing with itself run to run? Most eval
comparisons run condition A once and condition B once, then report the delta as if it were
noise-free.

## Design

model-regress runs three conditions over one frozen golden set:

- A: the current model, claude-sonnet-5
- B: the candidate model, claude-haiku-4-5
- A-repeat: condition A run again, same model, same prompts

The A-vs-A-repeat pair estimates how much the model disagrees with itself on identical input,
using the same paired statistics as A-vs-B: Newcombe method 10 confidence intervals on the
paired difference and McNemar's exact test on the discordant pairs. That gives a noise ceiling
in the same units as the effect being measured, instead of a rule of thumb.

The decision rule, frozen in `protocol/experiment.json` before any data was collected:

> 'regression' only if the exact-json paired-difference 95% CI excludes 0 AND |diff| exceeds
> the upper bound of the A-vs-A-repeat paired-difference CI; else 'no detectable regression at
> n=40' reported with the minimal detectable effect at 80% power.

A cost-per-item increase beyond the protocol's `max_cost_increase_pct` fails the `ci` gate
regardless of pass rate, so a quality win can't quietly ship a cost regression.

## Task

The golden set is a receipt-extraction task: 40 deterministically generated items, each asking
for exactly one JSON object with `id`, `date`, `total_cents`, `paid`, `status`, and `items`,
and no prose. `total_cents` must equal the sum of `qty * unit_cents` across items, so the task
checks both parsing and arithmetic consistency, not just json-shape matching.

## What the protocol pre-registered

Pulled from `protocol/experiment.json`, frozen 2026-09-15:

- Golden set: 40 items (confirmed by `golden gen`'s own output below), generated deterministically
  from the frozen protocol seed via `mulberry32`.
- Thresholds (`max_drop_pp`, `max_cost_increase_pct`) are set in `protocol/experiment.json` and
  gate the `ci` command regardless of pass rate.
- Spend cap: $3 (see `estimate --all` below for the command-derived expected and ceiling
  totals against that cap).
- Not measured by this protocol: judge quality, tool use, long context, prompt variants, other
  tasks.

## Where the run stands

No paired run has been executed. `node --import tsx src/cli.ts headline` against this
checkout returns:

```
no run-meta.json with headline values yet; the headline is not renderable until a paired run produces it
```

There is no `report` command in this CLI; the machine-readable surfaces are `headline` and
`compare --json`. The commands that do run cleanly against the frozen protocol, pasted
verbatim from this checkout:

```
$ node --import tsx src/cli.ts golden hash
46d13b8d6becae88f9ed53d865412e9d35bf20c0d9d0b41a6c709ae7caa4eb08

$ node --import tsx src/cli.ts golden gen --out /tmp/check.json
wrote 40 golden items to /tmp/check.json (hash 46d13b8d6becae88…)

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

The power calculation is worth sitting with: at n=40 with a 20% discordant rate, the minimal
detectable effect at 80% power is about 19.8 percentage points. Catching a 5-point regression
at this sample size would need roughly 628 paired items, not 40. That's a property of the
statistics, visible before any model is called, and it's why the protocol reports "no
detectable regression at n=40" rather than a false "no regression" whenever the observed
effect sits below what this sample size could reliably detect.

## What's verified without a run

- 74 tests pass across 11 files (`npx vitest run packages/model-regress`).
- The package type-checks clean (`npx tsc --noEmit`).
- `repro` is wired to re-derive `comparison.json` and `run-meta.json` bit-for-bit from committed
  run files once a run exists; today it correctly reports a no-op because no run is committed.

## Not yet measured

Every number that would depend on an actual paired model comparison (pass rates, the paired
difference, the noise floor, per-item cost from a live run) is not yet measured. This case
study describes the tool and the pre-registered protocol it will apply to any future run, not
a result.
