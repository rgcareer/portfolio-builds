# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

Pre-1.0: only the latest published version is supported.

## Reporting a vulnerability

Please report privately through [GitHub Security Advisories](https://github.com/rgcareer/agent-forensics/security/advisories/new)
rather than a public issue. Include the version, a minimal reproduction, and the impact you
expect. You should get an initial response within a few days.

## Scope

- This package makes no network calls and no LLM calls. `ingest` and `convert --from
  claude-code` read local `.jsonl` files only.
- Redaction is the security-relevant surface. Every field kept in a `RunRecord` comes from one
  of the helpers in `src/redact.ts`: an HMAC token bound to `PB_ANON_SALT`, an ISO timestamp, a
  small enum, or a count. There is no code path that copies a prompt, tool input, tool output,
  file path, or other free text into a record. `keepScalar` enforces this per key against an
  allowlist in `protocol/detectors.json`; anything not on the allowlist is dropped.
- `PB_ANON_SALT` must be at least 16 characters and is never printed, logged, or committed.
  `ingest` and `convert --from claude-code` refuse to run without it (`requireSalt`).
- The `audit` command sweeps everything committed under `data/` and `fixtures/` for redaction
  violations and exits 1 on any finding; it is meant to run before any commit that touches
  those directories.
- `show` is explicitly local-only: it prints raw, unredacted transcript content to the terminal
  for a human to read, and its own output must never be committed.
- A vulnerability report about a redaction gap (a field that leaks free text into a committed
  `RunRecord`) is treated as high severity regardless of how it was found.

## Out of scope

- The content of the transcripts you feed in. This tool processes what you give it; it does not
  vet the source.
- Anything downstream of `show`'s output, since that command is documented as unsafe to commit.
