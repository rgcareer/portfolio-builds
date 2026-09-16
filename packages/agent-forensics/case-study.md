---
slug: agent-forensics
title: Agent Forensics
tagline: Post-mortem tooling that turns a Claude Code transcript into a redacted record and points at the exact turn where a run broke.
role: Design + build
year: '2026'
status: built and measured
stack: [TypeScript, Node.js, citty, Vitest]
metrics:
  - label: Sessions with a breakdown signal
    value: 50.8% (95% Wilson CI 43.7-57.8%)
  - label: Sessions analyzed
    value: '189'
  - label: Tool calls analyzed
    value: '36480'
  - label: Tool-call error rate
    value: 2.5% (95% Wilson CI 2.3-2.6%)
  - label: Most frequent signature
    value: TIMEOUT (62 sessions)
tags: [agent-tooling, observability, forensics]
links:
  repo: https://github.com/rgcareer/agent-forensics
metrics_source:
  Sessions with a breakdown signal: data/run-meta.json#pct.p (Wilson interval at pct.lo/pct.hi)
  Sessions analyzed: data/run-meta.json#sessions
  Tool calls analyzed: data/run-meta.json#toolCalls
  Tool-call error rate: data/run-meta.json#pct.err_p (Wilson interval at pct.err_lo/pct.err_hi)
  Most frequent signature: data/run-meta.json#topClass (count at topK)
---

## Lead

I keep running Claude Code sessions that go sideways in ways I can't fully explain afterward:
a tool call loop, a retried command that never recovers, a session that just stops. This
package is the tool I built to stop guessing about why. Running it against 189 of my own
sessions found at least one of those patterns in 96 of them.

## Problem

When an agent session breaks, the evidence is a JSONL transcript full of prompts, file paths,
and command output. That is also the last thing I want to commit anywhere, and reading it by
hand doesn't scale past a handful of sessions. I wanted two things that don't usually come
together: a way to see, across many sessions, how often specific failure patterns show up, and
a way to keep the raw transcripts off disk in any shared or committed form.

## Approach

Every transcript goes through one parser that builds a `RunRecord` by construction, not by
filtering afterward. The record can only ever hold counts, durations, booleans, small enums,
and HMAC tokens; there is no code path anywhere in the adapter that copies a prompt, a tool
input, a tool output, or a file path into the record. Eleven detectors, frozen and hashed
before any transcript is read, look for loops, retries, API errors, refusals, dangling calls,
hook errors, and timeouts. Seven of those form the headline set; the rest are reported but
never counted toward it. Everything traces back to `protocol/detectors.json`, so I can't loosen
a threshold after seeing a result without the protocol hash changing and the frozen-protocol
audit catching it.

## The honesty feature

The headline sentence is never typed by hand. It's rendered by `renderHeadline` from a
committed `run-meta.json`, and the function throws on any unresolved placeholder, `TBD`, or
non-finite value, so a partial or fabricated number can't reach the README. That `run-meta.json`
now holds a real run, ingested from 189 of my own Claude Code sessions, and the command prints
the same sentence quoted in the README:

```
$ node --import tsx src/cli.ts headline
Across 189 of my own Claude Code sessions (2026-07-20 to 2026-09-16; 36480 tool calls), 96 (50.8%, 95% Wilson CI 43.7-57.8%) contain at least one pre-registered breakdown signature; the most frequent is TIMEOUT (62 sessions); 896 tool calls (2.5%, CI 2.3-2.6%) returned an error.
```

That's the honest state of this package today: built, tested, and pointed at real data.

## How I verified it

- `npx vitest run packages/agent-forensics` and `npx tsc --noEmit` both need to pass before any
  claim about this package is made.
- The commands above were run directly, not summarized, and their output is quoted verbatim in
  the README and here.
- `audit` sweeps everything under `data/` and `fixtures/` for redaction violations before any
  of it can be committed.
- `repro` re-derives `findings.json` and `run-meta.json` from committed records offline and
  fails on any byte-level mismatch.
