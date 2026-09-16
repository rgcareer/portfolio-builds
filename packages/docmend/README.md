# docmend

Points at a repo's docs, snapshots them, finds link/version/snippet/prerequisite drift against
external truth, and proposes a fix only where a machine can re-verify it.

## Result

```
$ node --import tsx src/cli.ts headline
Across 70 documentation pages (8 of Ryan's own: 4 public repos and 12 getsmartai.ai page(s); 50 external quickstarts snapshotted 2026-09-11) with 748 links, 267 code blocks and 5 version pins, 268 drift findings; 86 fixes proposed, 25 (29.1%, 95% Wilson CI 20.5-39.4%) pass independent re-verification.
```

```
$ node --import tsx src/cli.ts report --format md
```
```
# docmend report

Across 70 documentation pages (8 of Ryan's own: 4 public repos and 12 getsmartai.ai page(s); 50 external quickstarts snapshotted 2026-09-11) with 748 links, 267 code blocks and 5 version pins, 268 drift findings; 86 fixes proposed, 25 (29.1%, 95% Wilson CI 20.5-39.4%) pass independent re-verification.

Of the 86 fixes proposed, 19 are safe to auto-apply without human review; 0 finding(s) rely on an LLM judgment ([SIMULATED], confidence capped at 0.8) and are never auto-applied.

## Corpus
- Pages: 70 (8 own-repo across 4 repo(s), 12 site, 50 external)
- Links checked: 748 · Code blocks checked: 267 · Version pins checked: 5

## Drift by category
- broken-link: 45
- broken-relative-path: 3
- missing-prerequisite: 79
- placeholder-text: 24
- redirected-link: 96
- stale-pin: 1
- unparseable-snippet: 19
- version-drift: 1
```

The full report (every individual proposal, the ten pages with the most drift, LLM spend, and
the "not measured" list) is in [`out/report.md`](./out/report.md), rendered by the same
`report --format md` command from the same committed `data/run-meta.json`.

Both numbers above came straight out of the two commands shown, pasted as-is. Nothing in this
README is typed by hand.

## What it does / measures

Given a corpus of documentation pages, docmend:

1. Snapshots each page (own-repo Markdown, a same-origin site crawl, or an external
   quickstart) into `data/corpus/<pageId>/`, with a raw copy and a textified copy for line
   numbers that make sense.
2. Runs ten pre-registered checks against each page: broken and redirected links, package
   existence and stale or major-behind version pins, unparseable code fences, prerequisites
   used in code but never mentioned in prose, broken relative paths and npm scripts (own repos
   only), a Node engine mismatch, and leftover placeholder text.
3. Where a check's drift has a mechanical, re-checkable fix, proposes one: a redirect
   rewritten to its final URL, a version pin bumped to the registry's real latest, or a
   relative path rewritten to the one file in the repo tree that matches. A missing
   prerequisite gets one LLM-drafted sentence instead, always flagged as a judgment rather
   than a fact and never auto-applied.
4. Re-verifies every proposal independently of the check that found it: a fresh HTTP GET on
   the rewritten URL, a fresh registry lookup on the bumped version, the rewritten path
   checked against the committed repo tree, or the prerequisite check re-run against the
   patched text. A proposal only counts as verified when its diff also applies cleanly.
5. Aggregates everything into `run-meta.json`: corpus size, drift by category, how many
   proposals were made, how many passed re-verification with a 95% Wilson interval, and how
   many are safe to apply without a human reading them first.

A dead link is flagged, never guessed at. Nothing here rewrites a link it cannot confirm.

## Quick start

```bash
npx docmend scan --offline
npx docmend propose
npx docmend verify --offline
npx docmend headline
```

`scan --offline` and `verify --offline` run entirely against the committed corpus and
`lookup-cache.json`, so a first read of this repo costs nothing and touches no network.
Discovering and snapshotting a corpus from scratch needs `docmend run --live` instead (see
below).

## CLI

| Command | Does |
|---|---|
| `scan [--offline] [--fail-on cat,cat]` | Runs the drift checks over the committed corpus, writes `findings.json`. `--fail-on` exits 1 if any counted finding matches a listed category. |
| `propose [--offline] [--llm]` | Generates mechanical fix proposals; `--llm` also drafts prose-prerequisite sentences through the gateway. Writes `proposals.json` and `llm-calls.json`. |
| `verify [--offline]` | Independently re-verifies every proposal and recomputes `run-meta.json`. |
| `report --format md\|json` | Renders `out/report.md` or `out/report.json` from the committed data, unchanged by anything since `verify` ran. |
| `run --live [--llm]` | The full pipeline in one process: discover, snapshot, scan, propose, verify, report. Requires `--live` because it touches the network. |
| `headline` | Prints the headline sentence rendered from the committed `run-meta.json`. |
| `repro` | Re-derives `findings.json`, `proposals.json`, and `run-meta.json` from committed data, offline, and fails if the result differs by even one byte. |

Exit codes: `0` ok, `1` findings matched `--fail-on` or a repro mismatch, `2` usage or missing
config, `3` a caught runtime error.

## Library API

```ts
import {
  runChecks, proposeMechanical, proposeProsePrerequisite,
  reverifyProposal, applyUnifiedDiff, makeUnifiedDiff,
  computeRunMeta, renderDocmendHeadline,
  renderReportMarkdown, renderReportJson,
  HopAwareLookup, loadProtocol,
} from '@rgcareer/docmend';
```

`computeRunMeta(manifests, pageFindings, proposals, llm, protocolHash, protocolCommit)` is the
pure aggregation step: the same inputs always produce the same `run-meta.json`, which is what
makes `repro` meaningful.

## How it decides

Every check and safety rule is frozen in `protocol/checks.json` and `protocol/corpus-rule.json`
before any page is scanned; `loadProtocol` hashes both together, and the hash is written into
`run-state.json` at scan time so a threshold cannot be quietly tuned to fit a result afterward.

Checks:
- `D-link`: an absolute link resolves to 2xx or 3xx after its redirect chain. 404, 410, 403,
  timeout, and network failure are all flagged as broken; a 403 is never distinguished from a
  genuinely dead link.
- `D-redirect`: a permanent redirect (301/308) is counted as drift; a temporary one (302/307)
  is recorded but never counted.
- `D-pkg-exists` / `D-pin`: every package named in an install command exists in its registry,
  and its pinned version isn't behind the registry's real latest. Same major behind is
  `stale-pin`; a major behind is `version-drift`; a deprecated or yanked latest is flagged, not
  proposed.
- `D-code-parse`: fenced JSON, shell (`bash -n`), JS/TS (via the TypeScript compiler, an
  optional peer), and Python (`python3 -c 'import ast; ast.parse(...)'`) blocks parse. A block
  with an ellipsis is treated as an intentional fragment and skipped; a missing optional parser
  never produces a finding.
- `D-prereq`: an environment variable or CLI tool used inside a code block that prose never
  mentions anywhere on the page.
- `D-rel-path` / `D-script` / `D-engine`: own repos only. A relative path resolves to a file
  that exists in the repo tree, a documented `npm run` script exists in `package.json`, and the
  README's stated Node version matches `engines.node`.
- `D-placeholder`: `TODO`, `TBD`, `goes here`, `placeholder`, `coming soon`, or `lorem ipsum` in
  prose. Flagged only, never proposed.

Fix safety, straight from `checks.json`'s `fix_policy`:
- **redirect-rewrite** is safe to auto-apply only when every hop is permanent, the final status
  is 200, the host is unchanged (or differs only by scheme or a leading `www.`), the final path
  isn't `/` unless the original was, and the final URL doesn't look like a login or 404 page. A
  cross-host permanent redirect is proposed but marked unsafe; a redirect off the root path is
  flagged only, never rewritten.
- **pin-bump** is safe only when the registry's latest shares the pin's major version. A
  major-behind bump is proposed but never auto-applied; a deprecated or yanked latest is
  flagged only.
- **path-rewrite** is safe only when exactly one file in the repo tree shares the broken path's
  basename. Zero or more than one candidate is flagged with the candidates listed, never
  guessed at.
- **prose-prerequisite** is never safe to auto-apply. It's LLM-authored text, so a human reads
  it before it lands in a README.

`markdown.ts` and `textify.ts` are byte-identical copies from `onboarding-transfer-rate`
(`@615cfae`); `snippets.ts` copies its install-reference and JS/TS/Python parsing helpers and
adds JSON and shell parsing on top. `test/drift-guard.test.ts` hashes each copy against the
original so any future divergence is visible.

## Reproduce

```bash
node --import tsx src/cli.ts repro
```

`repro` re-derives `findings.json`, `proposals.json`, and `run-meta.json` from the committed
corpus and lookup cache, entirely offline, and fails if the result differs from what's
committed by even one byte (`generatedAt` and `checkedAt` timestamps excluded). Mechanical
proposals are recomputed fresh; the one LLM-authored proposal type is carried through from the
committed file rather than re-asked, since redrafting it isn't a $0, offline operation.

## Cost

The only LLM call is `docmend:prereq-prose`, drafting one sentence per missing-prerequisite
finding with `claude-sonnet-5`, capped at 400 tokens. It runs through `callLlm`, so it never
throws, is always ledgered, and defaults to a $0 mock responder unless `PB_SPEND_CAP_USD` is
set. Every result from it is marked `[SIMULATED]` at a confidence capped at 0.80, and is never
safe to auto-apply.

Network: `scan`/`verify` make read-only GET requests to check link chains and registry
metadata; `run --live` additionally crawls the configured site and reads the four own-repo
working trees on disk. Nothing here writes to a live site, a registry, or a repo without the
diff being applied by a human.

## What is NOT measured

Carried verbatim from `protocol/checks.json`:

- Snippet execution. Every parser checks syntax only; nothing in a fenced code block is run.
- The prose quality of any generated fix.
- The semantic correctness of any fix. Re-verification is mechanical (does the check stop
  firing, does the URL resolve, does the version exist), never a judgment about meaning.
- A 403 response is counted as broken and never distinguished from a genuinely dead link.

## Failure modes

- `D-redirect`'s safety check trusts the final response's status code; a site that returns 200
  for a soft-404 page looks like a valid redirect target.
- `D-prereq`'s env-var and tool patterns are regexes matched against code-block text, so an
  unrelated all-caps token that happens to look like an environment variable can trip a false
  positive.
- `path-rewrite` matches on basename only, so a repo with two files of the same name in
  different directories always flags ambiguous rather than guessing which one is meant.
- Lookup results are cached in `lookup-cache.json`; running `verify` in `--offline` mode
  reverifies against that cache, not against the live web, so a link that broke or a version
  that shipped after the cache was built won't show up until the next live run.

## Security

See [SECURITY.md](./SECURITY.md).

## License

MIT
