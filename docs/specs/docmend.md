# Spec: @rgcareer/docmend (bin `docmend`, npm script `docmend`)

Build under `packages/docmend/`. Read `tasks/conventions.md`. Import shared from `@portfolio-builds/shared`.
Tests first. This is the largest app — build it in two passes (scan side, then propose/verify side).

## What it is
Points at a repo's README/docs, snapshots them, finds link/version/snippet/prerequisite drift against external
truth (HTTP, npm, PyPI, parsers, the repo tree), proposes a fix ONLY where a machine can re-verify it, and
returns a PR-ready patch plus honest counts (found, proposed, passed re-verification). Dead links are flagged,
never guessed.

## Reuse (COPY with a provenance header, do not import)
OTR is private/frozen; copy `packages/onboarding-transfer-rate/src/{markdown.ts, textify.ts}` and the install/
parser helpers from its `l1.ts`/relevant module into `src/markdown.ts`, `src/textify.ts`, `src/snippets.ts`,
each with a header `// Copied 2026-09-15 from onboarding-transfer-rate @615cfae; diverges here.` Add a
`test/drift-guard.test.ts` that hashes the copies against the OTR originals so divergence is visible.

## Files
- `protocol/corpus-rule.json` (you write) — the four own repos (`{local, url, files:'README.md + docs/**/*.md'}`
  for evalcard, sop-mcp, trust-tool, prompt-field-kit from their local checkouts), tree exclusions
  (`node_modules|dist|.git|.claude|.env*|*.pem`), site origin `https://getsmartai.ai` + depth-1 + sitemap rule,
  external corpus pointer (OTR corpus dir `../onboarding-transfer-rate/data/corpus`, `q_*` only, record OTR's
  protocol hash + commit), link exclusion regex + caps (all links for own pages, first 25 for external — match
  OTR's frozen rule), fetch policy (timeout 15000, max 2MB, UA `portfolio-builds-docmend/0.1 (research;
  +https://github.com/rgcareer)`, concurrency 4, 250ms per-host gap, one retry).
- `protocol/checks.json` (you write) — check ids/patterns (below), `drift_categories`, `fix_policy` (safety
  conditions per category), `reverify_methods`, `headline_template`, stats rule, `not_measured` (snippet
  execution, prose quality, semantic correctness of any fix, 403 counts as broken).
- `src/{protocol, markdown, textify, snippets, sources, snapshot, lookup, checks, propose, llm, patch, reverify,
  analyze, report, types, index, cli}.ts`.
  - `snippets.ts` adds `parseJson` and `parseShell` (`bash -n` on `bash|sh|zsh|shell` fences, prompts stripped,
    `...` blocks skipped; `console`/`text` fences ignored); JS/TS via `typescript` (optional peer — missing =
    "cannot judge", never a finding); Python via `python3 -c 'import ast,sys; ast.parse(...)'`.
  - `sources.ts`: own-repo discovery (README + docs/**/*.md, tree list minus exclusions, provenance
    `git -C <repo> rev-parse HEAD` + remote URL + porcelain count); site crawl (`/` + same-origin depth-1 +
    sitemap if 200); external adapter over OTR manifests.
  - `snapshot.ts`: `data/corpus/<pageId>/{raw.md|raw.html, text.txt, manifest.json}`, pageId =
    `sha256(source+path)[:10]`.
  - `lookup.ts`: `HopAwareLookup` — `link:` chain walk ≤5 hops via `safeFetch(url, {}, {maxHops:0})` capturing
    `[{url,status,location}]` + finalUrl; `npm:`/`pypi:` info with `versions[]`; `verify:` keys for independent
    re-fetches; modes `live|snapshot` (snapshot throws on miss like OTR).
- `data/{sources, lookup-cache, findings, proposals, run-meta, run-state, llm-calls}.json`,
  `data/corpus/`, `out/patches/<repo>.patch`, `out/patches/<repo>/<pageId>-<proposalId>.diff`, `out/report.md`.

## Checks (all $0 unless noted; in checks.json)
`D-link` (2xx/3xx after chain OK; 404/410/403/timeout/network → `broken-link`, flag only) · `D-redirect`
(301/308 chain → `redirected-link`, counted; 302/307 → informational) · `D-pkg-exists` · `D-pin`
(`stale-pin` same-major, `version-drift` major-behind, deprecated/yanked → flag) · `D-code-parse` (per snippet
langs above) · `D-prereq` (OTR rule verbatim) · `D-rel-path` (own repos only) · `D-script` (`npm run X` with no
such script) · `D-engine` (README Node claim vs `engines.node`) · `D-placeholder`
(`TODO|TBD|goes here|placeholder|coming soon|lorem`, flag only).

## Proposals + safety (mechanical, $0)
`redirect-rewrite`: `safe_to_auto_apply` iff every hop ∈ {301,308}, final 200, host unchanged or scheme/`www.`
-only change, final path not `/` unless original was, final URL matches none of `login|signin|404|not-found`;
cross-host permanent → proposed unsafe; root redirect → flag only. `pin-bump` to the registry's real `latest`:
safe when same major; major-behind proposed unsafe; deprecated latest → flag. `path-rewrite`: safe iff exactly
one tree file shares the basename; else flag with candidates. NO proposal ever derives from a 404.
`src/llm.ts` `prose-prerequisite` (the ONE spend step, `docmend:prereq-prose`, `claude-sonnet-5`, maxTokens
400): one prose sentence per `missing-prerequisite` finding; every result `[SIMULATED]`, cap 0.80,
`safe_to_auto_apply:false`; gateway errors counted in `llm.errors`; a mock responder returns a fixed sentence
so tests + default run are $0.

## Re-verification (every proposal, independent of the probe that found it)
`http-get-final` (fresh `verify:` GET → 200, 0 hops) · `registry-version-exists` (npm/pypi 200, not
deprecated/yanked) · `tree-path-exists` · `recheck-patched-text` (LLM proposals: the check no longer fires and
no new counted finding appears) · plus `patch-applies` for all (`applyUnifiedDiff(raw)===expected`; for
`repo-file` targets also `git apply --check` on a copy in `$TMPDIR`). `pass` requires patch-applies AND the
method. `makeUnifiedDiff` = single hunk, 3 lines context, line located by a unique substring; non-unique →
`ambiguous`, no diff.

## Data model
`Finding {id, pageId, checkId, category, line, excerpt, detail, counted, evidence}`. `Proposal {id, findingId,
pageId, category, source:'mechanical'|'llm', independence:'measured'|'[SIMULATED]', confidence?, model?,
safe_to_auto_apply, reason, evidence, edit:{line,old,new}, diff, target:{kind:'repo-file'|'live-page'|
'external-snapshot', repo, path, prReady}, reverify:{status:'pass'|'fail'|'skipped', methods[], evidence,
checkedAt}}`. `RunMeta` per design (corpus/drift/proposals blocks; `pct` = wilson over verified/proposed or null).

## Headline (template in checks.json; render via `renderHeadline`)
"Across {pages} documentation pages ({own} of Ryan's own: {repos} public repos and {site_pages}
getsmartai.ai page(s); {ext} external quickstarts snapshotted 2026-09-11) with {links} links, {snippets} code
blocks and {pins} version pins, {drift} drift findings; {proposed} fixes proposed, {verified} ({p}%, 95%
Wilson CI {lo}-{hi}%) pass independent re-verification." `proposed=0` → `pct:null` → generator refuses → README
"Not yet measured." A second labelled sentence reports safeToAutoApply and `[SIMULATED]` counts; not the headline.

## CLI (citty; `--json`; exit 0 ok / 1 findings matched `--fail-on` / 2 usage/config / 3 runtime)
`scan [--offline] [--fail-on cat,cat]` · `propose [--offline] [--llm]` · `verify [--offline]` · `report
--format md|json` · `run --live` (snapshot→scan→propose→verify in ONE process, so the day needs one egress
override) · `headline` · `repro`.

## Tests (name each; ≥28; fixtures + fake lookup; $0)
drift-guard hashes vs OTR fixtures · chain classification (scheme upgrade safe, 302 informational, root
redirect flag, cross-host unsafe, 6 hops broken) · pin policy (same-major safe, major unsafe, deprecated flag,
PEP 503) · rel-path (exists/unique/ambiguous/none) · script & engine drift · placeholder · JSON & `bash -n`
parsing with prompt stripping · diff generator round-trip as a seeded property test (`apply(diff(a,b))===b`)
and ambiguity refusal · reverify per method with a fake lookup · LLM step in mock mode (ledger mock=1, cost 0,
`[SIMULATED]`, cap 0.80, error path counted) · aggregation determinism + headline-from-run-meta only · refusal
at proposed=0 · protocol hash sensitivity · CLI smoke on the fixture corpus with exit codes · `assertNoPii`
over generated fixtures · source-discovery exclusions.

## Repro & audits (main session wires tests.json)
`docmend repro` re-derives findings.json + proposals.json + run-meta.json + out/ offline, bit-for-bit (exclude
generatedAt). Provide logic for protocol-frozen, pii-sweep, readme-headline, case-study, and patch-applies
(`git apply --check` of every repo-file diff against a snapshot copy in `$TMPDIR`; recounts verified).

## Build order
PASS A: protocol files → copies + drift-guard → snippets → sources → snapshot → lookup → checks + tests.
PASS B: propose → llm (mock) → patch → reverify → analyze → report → CLI + tests. The main session runs
`run --live` (one override) and S-DM-1 later. Return blocked on any measured-number or safety-policy ambiguity.
