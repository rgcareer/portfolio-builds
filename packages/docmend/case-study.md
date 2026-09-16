---
slug: docmend
title: docmend
tagline: Finds real drift in documentation and only proposes a fix it can re-check itself.
role: Design + build
year: '2026'
status: shipped
stack: [TypeScript, Node.js, citty, Vitest]
metrics:
  - label: Documentation pages scanned
    value: '70'
  - label: Drift findings
    value: '268'
  - label: Fixes proposed
    value: '86'
  - label: Verified fix rate
    value: '29.1% (95% CI 20.5-39.4%)'
  - label: Safe to auto-apply
    value: '19'
metrics_source:
  Documentation pages scanned: corpus.pages
  Drift findings: drift.total
  Fixes proposed: proposals.proposed
  Verified fix rate: proposals.pct (p / lo / hi)
  Safe to auto-apply: proposals.safeAuto
tags: [documentation, dev-tools, cli]
links:
  repo: https://github.com/rgcareer/docmend
flip:
  before: A README link check that flags dead links with no idea whether a fix is safe.
  after: A tool that proposes a fix only when it can also prove that fix independently.
---

## Lead

I run docmend against my own public repos, my site, and a snapshot of fifty external
quickstart guides. Across 70 pages it found 268 drift findings, proposed 86 fixes, and only 25
of those passed a second, independent check before I'd call them verified.

## The problem

Every "check my docs" tool I'd used stops at finding the problem. It tells you a link is dead
or a version pin is old, then leaves you to decide what to do about it. The riskier version of
that tool guesses at a fix and writes it back without telling you how confident it actually is.
I wanted something in between: propose a fix, but only when a machine, not me, can independently
confirm the fix is correct before it ever reaches a pull request.

## The approach

docmend snapshots a page, runs ten checks against it (broken links, permanent redirects,
package existence, stale or major-behind version pins, unparseable code fences, missing
prerequisites, broken relative paths, missing npm scripts, a Node engine mismatch, and
leftover placeholder text), and stops there for most of them. A fix only gets generated when
the drift maps to something re-checkable: a redirect gets rewritten to its final URL, a stale
pin gets bumped to the registry's real latest, a broken relative path gets rewritten to the one
file in the repo tree that matches. Everything else is flagged and left alone.

The one place an LLM touches this pipeline is drafting a sentence for a missing prerequisite,
and even that never gets treated as fact. It's marked `[SIMULATED]`, capped at 0.80 confidence,
and never marked safe to auto-apply, because prose is a judgment call and a judgment call
belongs in front of a human before it lands in a README.

## The honesty feature

Every proposal gets re-verified independently of the check that found it: a fresh HTTP request
on the rewritten URL, a fresh registry lookup on the bumped version, the rewritten path checked
against the actual repo tree. A proposal only counts as verified when its diff also applies
cleanly to the page it targets. That's why the headline reports 25 verified out of 86 proposed
rather than 86 out of 86: most of what got proposed either had no clean diff to apply, targeted
a page that wasn't safe to auto-rewrite (a cross-host redirect, for instance), or simply failed
the independent recheck. The 29.1% verified rate carries its own 95% Wilson interval (20.5% to
39.4%) rather than being reported as a bare percentage, and if no proposals had been made yet
the headline generator would refuse to print a rate at all instead of showing a misleading zero.

## How I verified it

Every number in this case study came from running `docmend headline` and
`docmend report --format md` against the committed run and pasting the output verbatim. The
`repro` command re-derives the same findings, proposals, and run-meta entirely offline from
what's already committed, and fails loudly if the result differs from the committed files by
even one byte. `markdown.ts`, `textify.ts`, and the shared snippet parsers are copied from an
earlier project of mine (`onboarding-transfer-rate`), and a dedicated test hashes each copy
against the original so I'd notice if one drifted without me meaning it to.
