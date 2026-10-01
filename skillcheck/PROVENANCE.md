# Provenance

Skillcheck lives as a git **subtree** at `skillcheck/` inside the `portfolio-builds` monorepo
(imported 2026-09-10, decision D-002 — history kept). It began life as a standalone repository at
`~/Desktop/1-projects/skillcheck`; that original is retained read-only and is **not** the source of
truth.

## Code version recorded in published data

Every published `run-meta.json` records where the code that produced it lives:

| field | meaning |
|---|---|
| `codeRepo` | `portfolio-builds` — the enclosing repository |
| `subtreePath` | `skillcheck` — the subtree path within it |
| `codeVersion` | the enclosing-repo `HEAD` resolved at screen time (`git rev-parse HEAD`) |
| `codeVersionVerified` | `true` iff `codeVersion` still resolves to a commit that is an ancestor of `HEAD` in this repo at publish time |

`codeVersionVerified` is computed by `packages/publish/src/serialize.ts` (`buildArtifacts`), which
refuses to claim a provenance it cannot resolve: a `codeVersion` that is absent, malformed, or not
present in this repository's history publishes as `codeVersionVerified: false`.

## Historical note — the pre-import `codeVersion` (M1, snapshot 2026-08-25)

The first published M1 run-meta recorded:

```
codeVersion: 410bf2f9082f6d0c0eb5ee40afbdf323f7255abb
```

That SHA is a commit of the **pre-import standalone repository** (it exists at
`~/Desktop/1-projects/skillcheck`, subject "publish: headline generator + committed-data checksum
test"), **not** a commit in this monorepo. It predates the subtree import (D-002), so it was never
an ancestor of the monorepo `HEAD`, and the 2026-09-16 history rewrite's SHA remap (D-026) did not
cover it because that remap only touched monorepo-era commits.

**No history surgery was performed for this.** The dangling reference resolves itself by
regeneration: the 2026-10-01 marketplace-fix re-harvest (D-027) re-ran the full
harvest → screen → publish pipeline, superseding that run-meta wholesale with a `codeVersion` that
is the monorepo `HEAD` and therefore `codeVersionVerified: true`. The historical SHA is documented
here rather than rewritten — D-026 transparency: the import is a matter of record, not a secret.

## Why the M1 "official cohort" headline changed

The 2026-08-25 M1 headline ("20 official Claude Code skills in `anthropics/skills`") **undercounted
the official cohort**: a harvest bug classified the Claude Code marketplace's in-repo plugin paths
(e.g. `plugins/code-review`) as external `owner/repo` references, which 404'd and silently
contributed zero skills (D-027). The marketplace fix resolves such paths against the marketplace
repo's own tree and harvests the plugin skills, so the corrected cohort includes every skill shipped
in Claude Code's own plugins. The replacement headline is generator-derived from the re-harvested
data — never hand-typed.
