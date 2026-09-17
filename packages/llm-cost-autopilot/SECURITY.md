# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

This package is pre-1.0. Only the latest published version is supported.

## Reporting a vulnerability

Please report privately via [GitHub Security Advisories](https://github.com/rgcareer/portfolio-builds/security/advisories/new) rather than a public issue. Do not open a public issue for a security report.

## Scope

- **In scope**: the extractor's handling of Claude Code transcripts and the ledger, the HMAC tokenization of session and project identifiers, the price table loader, and anything that writes to `data/`.
- **Out of scope**: the accuracy of Anthropic's published prices themselves (this package loads them from a committed, dated table and never re-derives them from a live API).

## What this package handles

- **Raw transcripts** under `~/.claude/projects` are read, never written or modified, and never committed. Only derived, redacted records reach `data/traffic/*.jsonl`.
- **Session and project identifiers** are HMAC-tokenized (`makeTokenizer(requireSalt())`) before they are written anywhere. `cwd`, `gitBranch`, `uuid`, and `requestId` are dropped entirely rather than tokenized, since dropping them removes the join risk instead of just obscuring it.
- **The salt** (`PB_ANON_SALT`) is read from the environment, required to be at least 16 characters, and is never committed, logged, or printed. `extract` refuses to run without it (exit 1).
- **Prompt and response content** is never read or stored by this package; only token counts, timestamps, and model names are extracted.
- Every committed file under `data/` is expected to pass `assertNoPii` before it's checked in.

## Reserved files

This package does not touch `tests.json`, the root `package.json`, `package-lock.json`, `PROGRESS.md`, `evidence/`, or any other package's directory. It never reads a `.env` file directly; env-dependent runs go through the `lca:live` script.
