# Skillcheck

> Working name. A public, honest, continuously-updated quality + security audit of the
> Claude Code Agent Skills ecosystem.

**Milestone M1 — "The Scan":** static analysis over the full harvested cohort of skills,
producing per-skill **Safety** and **Hygiene** grades plus a defensible headline number.
Effectiveness and Honesty grades arrive in M2 (they render as *"Not yet benchmarked"* now).

M1 runs **static analysis only** — it never executes a skill. Every finding carries
machine evidence (rule id + file + line + sanitized matched text).

## Layout

```
packages/core      SQLite db + schema, LLM gateway (cost-logged), model-policy guard,
                   SSRF-safe fetch, deterministic serialization/PRNG, frontmatter validator
packages/harvest   cohort enumeration (gh/GitHub API) + guarded mirror
packages/screen    YAML rule packs + static engine + claim extractor + deterministic grading
packages/publish   SQLite → site JSON with structural disclosure redaction
site/              Astro static site (Cloudflare Worker)
```

## Reproduce

Requires Node ≥ 22.12.

```bash
npm ci
npm test                                  # rule-pack goldens + determinism checks
npm run screen -- --sample 25 --seed 7    # reproduces published grades bit-for-bit
```

## Model policy

Any Opus-tier model call uses `claude-opus-4-8`. `claude-opus-5` is excluded everywhere;
`packages/core/src/models.ts` throws at load if any such id appears in the roster or price table.

## Status

Pre-release. Findings are not published until the responsible-disclosure policy is live and
the 14-day author-notice flow has run; until then any dangerous skill is shown anonymized.
