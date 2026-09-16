---
slug: agent-forensics
title: Agent Forensics
tagline: Post-mortem tooling that turns a Claude Code transcript into a redacted record and points at the exact turn where a run broke.
role: Design + build
year: '2026'
status: built, not yet run
stack: [TypeScript, Node.js, citty, Vitest]
metrics: []
tags: [agent-tooling, observability, forensics]
links:
  repo: https://github.com/rgcareer/agent-forensics
metrics_source: {}
---

## Lead

I keep running Claude Code sessions that go sideways in ways I can't fully explain afterward:
a tool call loop, a retried command that never recovers, a session that just stops. This
package is the tool I built to stop guessing about why.

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
non-finite value, so a partial or fabricated number can't reach the README. Right now there is
no `run-meta.json` at all, because I haven't ingested any sessions yet, and both required
commands say so plainly:

```
$ node --import tsx src/cli.ts headline
headline: no data/run-meta.json — run analyze first
```

That's the honest state of this package today: built, tested, not yet pointed at real data.

## How I verified it

- `npx vitest run packages/agent-forensics` and `npx tsc --noEmit` both need to pass before any
  claim about this package is made.
- The commands above were run directly, not summarized, and their output is quoted verbatim in
  the README and here.
- `audit` sweeps everything under `data/` and `fixtures/` for redaction violations before any
  of it can be committed.
- `repro` re-derives `findings.json` and `run-meta.json` from committed records offline and
  fails on any byte-level mismatch, once a real run exists to check against.
