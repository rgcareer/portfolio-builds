# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

Pre-1.0: only the latest published version is supported.

## Reporting a vulnerability

Please report privately through [GitHub Security Advisories](https://github.com/rgcareer/portfolio-builds/security/advisories/new)
rather than a public issue. Include the version, a minimal reproduction, and the impact you
expect. You should get an initial response within a few days.

## Scope

- `scan` and `verify` make read-only GET requests to check link redirect chains and npm/PyPI
  registry metadata. `run --live` additionally crawls the site configured in
  `protocol/corpus-rule.json` (depth 1, same origin) and reads the four own-repo working trees
  named there from local disk. Nothing here writes to a live site, a package registry, or a
  repository. Every proposed change is a diff a human applies by hand.
- The one LLM call (`docmend:prereq-prose`) goes through `callLlm`, defaults to a $0 mock
  responder, and every result it produces is marked `[SIMULATED]`, capped at 0.80 confidence,
  and `safe_to_auto_apply: false`. It never sees anything beyond the single finding's excerpt
  and surrounding line.
- `applyUnifiedDiff` only ever touches an in-memory string or a `$TMPDIR` scratch copy during
  re-verification (`git apply --check`); it never writes to a real repo file itself.
- `assertNoPii` runs in tests over generated fixtures. Committed corpus snapshots are public
  documentation pages and public repo trees; no private transcript, prompt, or credential is
  ever read or stored by this package.
- A vulnerability report about a proposal marked `safe_to_auto_apply: true` that could actually
  break a link, misresolve a path, or point at a wrong package version is treated as high
  severity regardless of how it was found.

## Out of scope

- The content of the pages you point docmend at. This tool checks documentation against
  external truth; it does not vet whether the documentation's claims are otherwise honest.
- Anything downstream of a human choosing to apply a proposal marked unsafe or unverified. The
  point of `safe_to_auto_apply` and `reverify.status` is to tell you which ones need a read
  first.
