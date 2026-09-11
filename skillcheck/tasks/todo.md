# Skillcheck — Live State (todo.md)

**Project:** public, honest, static-analysis quality + security audit of the Claude Code
Agent Skills ecosystem. This session owns ONLY `skillcheck`.

**Current milestone:** M1 "The Scan" (static only, no code execution).
**M1 deliverable (a number):** "I scanned N Claude Code skills — X% carry prompt-injection
patterns, Y% are abandoned."

**Approved plan:** `~/.claude/plans/role-you-are-a-smooth-clock.md`
**Source-of-truth spec:** `~/.claude/plans/please-conduct-a-full-foamy-quasar.md`

## Hard constraints
- Model policy: any Opus-tier call = `claude-opus-4-8`; NEVER `claude-opus-5`.
  `packages/core/src/models.ts` asserts-throws at load on any `/claude-opus-5/` id.
- Static-only in M1. Never execute a skill. Dynamic sandbox = M2.
- Evidence per finding (ruleId + file + line + sanitized matched-text). No bare accusations.
- Naming a dangerous skill publicly requires the 14-day disclosure flow; until then
  findings publish anonymized placeholders. This gate is STRUCTURAL in publish, not policy text.
- Commit locally only. Ryan pushes (GitHub Desktop). Never push / never deploy findings.

## Environment notes
- Node v24.16 (engines require >=22.12). `node:sqlite` available as fallback (unused; better-sqlite3 v13 builds on Node 24).
- `gh` CLI NOT installed, no Homebrew, no GITHUB_TOKEN/GH_TOKEN, no git credential helper.
  api.github.com IS reachable unauthenticated (60 req/hr; code search + repo search need auth).
- **Harvest access decision (this session):** built the full harvest package with a token-aware,
  injectable client + mock tests. Sources A (anthropics/skills) + B (official marketplace) run
  unauthenticated (real, first-party, low-risk). Sources C (registries) + D (code search) need auth.
  **Runbook for the FULL real number:** set `GITHUB_TOKEN=<pat>` then
  `npm run harvest && npm run screen -- --sample 25 --seed 7 && npm run publish`.
  Until then the site publishes the official (A+B) cohort or the fixture demo dataset, labeled honestly.

## Build order (see task list in harness; mirrors plan §"Build order")
1. Bootstrap ⟵ in progress
2–5. core: db/schema, models guard, llm gateway, utils
6–10. screen: rules schema, engine, packs+fixtures+goldens, claims, grades+CLI
11–13. harvest A/B, C/D, real runs
14. publish + disclosure
15. site
16. headline + review + final sweep

## Definition of Done (evidence, not assertion) — STATUS
- [x] Rule-pack goldens byte-match committed fixture corpus (vitest).
- [x] `npm run screen -- --sample 25 --seed 7` reproduces canonical output bit-for-bit (verified
      twice on real data; official cohort_hash 94592404f09243a2).
- [x] Publish output checksum-verified vs site/src/data (published-data.test.ts).
- [x] Disclosure page live before any real skill named; publish refuses otherwise (preflight +
      assertDisclosureCoverage; redaction grep-test = zero identifiers).
- [x] Build green (169 tests); site builds + serves locally (6 pages, 20 rows, no third-party).
- [x] Fresh-context review DONE — mirror/redaction/determinism confirmed sound; 3 material
      findings fixed (doc-context rule FPs + injection-docs fixture, gunzip bomb cap, sanitizer
      UNI-004 codepoints) + null-pushed-at abandoned-bias. Re-screened/re-published (ruleset efec9326).

## M1 COMPLETE (2026-08-25). 11 local commits on main. NOTHING PUSHED (Ryan pushes).
Open items for Ryan: (1) push via GitHub Desktop; (2) provide GITHUB_TOKEN for the full
community-cohort number (runbook in README); (3) finalize public brand name before launch.

## Real M1 result (official anthropics/skills cohort, snapshot 2026-08-25)
20 skills · 0% injection · 0% abandoned · 0% unicode · 0% critical · 18 Safety A / 2 C · all Hygiene B.
Full-ecosystem number needs GITHUB_TOKEN (runbook in README). NOTHING PUSHED — Ryan pushes.
