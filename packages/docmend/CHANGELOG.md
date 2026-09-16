# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-09-15

### Added

- Corpus snapshotting for three source kinds: own repos (README + `docs/**/*.md`), a same-origin
  depth-1 site crawl, and external quickstarts adapted from `onboarding-transfer-rate`'s frozen
  corpus, into `data/corpus/<pageId>/{raw, text.txt, manifest.json}`.
- Ten pre-registered checks in `protocol/checks.json` (`D-link`, `D-redirect`, `D-pkg-exists`,
  `D-pin`, `D-code-parse`, `D-prereq`, `D-rel-path`, `D-script`, `D-engine`, `D-placeholder`),
  hashed at load time so a threshold can't change after data collection.
- Mechanical proposal generation for three drift categories (`redirect-rewrite`, `pin-bump`,
  `path-rewrite`), each gated by an explicit safety rule from `checks.json`'s `fix_policy`, plus
  one LLM-authored category (`prose-prerequisite`) that is always `[SIMULATED]`, capped at 0.80
  confidence, and never safe to auto-apply.
- Independent re-verification per proposal category (`http-get-final`, `registry-version-exists`,
  `tree-path-exists`, `recheck-patched-text`), plus `patch-applies` for every proposal.
- `analyzeRunMeta`-style aggregation with a 95% Wilson interval on the verified-proposal
  proportion, and `renderDocmendHeadline` so the headline sentence always comes from committed
  data, never a live recount.
- CLI: `scan`, `propose`, `verify`, `report`, `run --live`, `headline`, `repro`.
- `markdown.ts` and `textify.ts` copied byte-identical from `onboarding-transfer-rate` (`@615cfae`);
  `snippets.ts` copies its install-reference and JS/TS/Python parsers and adds JSON and shell
  (`bash -n`) parsing. `test/drift-guard.test.ts` hashes every copy against the original.
- `repro` command that re-derives `findings.json`, `proposals.json`, and `run-meta.json` from
  committed data, offline, bit for bit.
- First live corpus run: 70 pages (8 own-repo across 4 repos, 12 site pages, 50 external
  quickstarts), 268 counted drift findings, 86 fixes proposed. See the README's Result section
  for the exact headline and report output.
