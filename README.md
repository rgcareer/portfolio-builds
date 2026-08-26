# Skillcheck

> Working name. A public, honest, continuously-updated quality + security audit of the
> Claude Code Agent Skills ecosystem. **Independent — not affiliated with Anthropic.**

**Milestone M1 — "The Scan":** static analysis over the harvested cohort of skills, producing
per-skill **Safety** and **Hygiene** grades plus a defensible headline number. It **never
executes a skill**. Every finding carries machine evidence (rule id + file + line + sanitized
matched text). Effectiveness and Honesty grades arrive in M2 — until then they render as
*"Not yet benchmarked."*

## The M1 result (official cohort)

Generated from the published data by `npm run headline`, never hand-typed:

> I scanned the 20 official Claude Code skills in `anthropics/skills`: 0% carry
> prompt-injection patterns, 0% are abandoned, 0% contain non-standard Unicode, and 0% have a
> critical finding.

The community cohort (registries + GitHub code search, thousands of skills) requires an
authenticated token — see the runbook below. The methodology, grades, and site extend to it
unchanged.

## Layout

```
packages/core      SQLite db + schema, LLM gateway (cost-logged), model-policy guard,
                   SSRF-safe fetch, deterministic serialization/PRNG, frontmatter validator
packages/harvest   cohort enumeration (GitHub API) + guarded tarball mirror + dedupe
packages/screen    YAML rule packs + static engine + claim extractor + deterministic grading
packages/publish   SQLite → site JSON with structural disclosure redaction + checksums
site/              Astro static site (Cloudflare Worker assets)
```

## Reproduce

Requires Node ≥ 22.12.

```bash
npm ci
npm test                                  # 166 tests: rule-pack goldens + determinism + redaction
npm run screen -- --sample 25 --seed 7    # reproduces the published grades bit-for-bit
npm run headline                          # regenerates the headline sentence from run-meta.json
```

## Full pipeline

```bash
# 1. Harvest the cohort into data/skillcheck.db (+ data/mirror). Both are gitignored.
npm run harvest -- --snapshot 2026-08-25 --sources anthropic,marketplace

# 2. Static-screen the cohort, persisting grades + findings to the DB.
npm run screen

# 3. Publish SQLite → site/src/data/*.json (redacted, checksummed).
npm run publish

# 4. Build the static site.
npm run build:site
```

### Full-cohort runbook (community skills)

Sources C (community registries) and D (GitHub code search) require an authenticated GitHub
token (code/repo search and a workable rate limit). To produce the full-ecosystem number:

```bash
export GITHUB_TOKEN=<a github personal access token>
npm run harvest              # now includes registries + code search (size-sliced, ">= N" honest)
npm run screen && npm run publish
```

## Model policy

Any Opus-tier model call uses `claude-opus-4-8`. `claude-opus-5` is excluded everywhere,
including benchmark rosters; `packages/core/src/models.ts` throws at load if any such id
appears in the roster or price table. M1 makes **no** LLM calls — it is pure regex/codepoint
analysis (~$0).

## Disclosure

Findings are not published naming a skill until the responsible-disclosure policy
(`site/src/pages/disclosure.astro`) is live and the 14-day author-notice flow has run. Until
then any skill with a critical finding is fully anonymized (an `SC-ANON-…` placeholder, grades
`under_review`, evidence withheld); publish **refuses** to emit findings if the disclosure page
is absent or a qualifying skill lacks a disclosure record. Naming is a deliberate, human
`disclose release` after the window elapses.

## Determinism

Screening and publishing are wall-clock-free: hygiene ages derive from the snapshot date, and
`Math.random` / `localeCompare` / locale formatting are lint-banned outside the sanctioned PRNG.
Given a snapshot and ruleset, `screen --sample N --seed S` reproduces the published grades
bit-for-bit, and `publish` re-emits byte-identical artifacts.
