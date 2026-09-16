# Should I Trust This to AI?

A calm, single-purpose instrument for one decision: **how much should you trust an AI
with this task?** Answer a short guided flow and it scores the task on six dimensions,
then routes you to the lightest safe way to use AI, from *just let it run* to
*keep a human firmly in the loop*. The reasoning is shown, not felt.

It is a faithful, deterministic port of the **Victoria 4.0** router (`§2`): the
six-dimension scorer, the tier thresholds, the stakes-2 rule, the route-down tie-breaker,
and the decompose-at-14 gate. Where the source prose is ambiguous, the port is pinned to
the skill's own §12 calibration table (encoded as the test suite) — because the skill's
rule is *"if your routing disagrees with this table, the table wins."*

## What it does

- **Guided flow** (7 questions, one at a time, animated): complexity, stakes,
  reversibility, external-facts freshness, artifact, recurrence, ambiguity, plus one
  advisory verification question.
- **Verdict card** with a visible **scorecard** (the six dimensions and the total),
  a plain-English meaning, the **required gates**, a copyable **stop-test / loop-spec
  template**, and a "how this was computed" trace.
- **Two worked presets** (one high-stakes, one trivial) that demonstrate route-DOWN
  discipline: the same instrument that says "human in the loop" for an irreversible client
  email says "just let it run" for rewording a sentence.
- **Shareable via URL** (`?a=12130110`) — the URL *is* the state. No accounts, no backend,
  no persistence. Everything runs in the browser.

## The router (deterministic)

Six dimensions, each 0–3 (max 18): complexity, stakes, external facts, artifact creation,
recurrence, ambiguity. Tiers:

| Tier | Trigger |
|---|---|
| 0 | total 0–3 **and** no single score > 1 |
| 1 | total 4–7, or a single structured deliverable |
| 2 | total 8–13, **or** stakes = 3, **or** a code/system/file deliverable |
| decompose | total ≥ 14 → split into sub-goals |

Stakes = 2 does **not** force Tier 2 (it forces full-strength blocking gates at the tier
the total selects); only stakes = 3 does. The flow's "reversibility" question folds into
`stakes` as a MAX (irreversibility is the skill's own top stakes anchor); the
"verification" question is advisory and never changes the score, keeping routing
deterministic against §12.

See `src/router/router.ts` for the annotated port and
`src/router/router.calibration.test.ts` for the 10 golden routings.

## Develop

```bash
npm install
npm run dev       # local dev server
npm test          # router tests incl. all 10 §12 calibration routings
npm run build     # static build → dist/
npm run preview   # serve the built dist/
```

`dist/` is a fully static bundle — deploy to Cloudflare Pages, Netlify, or any static
host. Zero backend, zero API calls.

---

Built by **Get Smart AI**. The math is transparent by design: open the console, read the
scorecard, check the reasoning. Trust the instrument because you can see how it works.
