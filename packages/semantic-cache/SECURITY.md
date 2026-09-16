# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

Pre-1.0: only the latest published version is supported.

## Reporting a vulnerability

Please report privately through [GitHub Security Advisories](https://github.com/rgcareer/semcache/security/advisories/new)
rather than a public issue. Include the version, a minimal reproduction, and the impact you
expect. You should get an initial response within a few days.

## Scope

- **Cache poisoning and cross-namespace leakage.** A namespace is `{tenant, model,
  systemSha256, mock}`. `Store.listNamespace` scopes every lookup to that exact namespace, so
  one tenant's stored responses cannot be returned to another tenant, another model, or another
  system prompt, and mock traffic never mixes with real traffic. This isolation is structural
  (a WHERE clause on the namespace fields), not adversarially tested; see "What is NOT
  measured" in the README.
- **Wrong-answer risk from a semantic false hit.** The published curve's false-hit rate
  (6.7%, 95% Wilson CI 3.4-12.6% at the shipped threshold) is exactly the rate at which this
  cache can serve a stored response to a query that meant something different. `slotGuard`
  reduces this for numeric, identifier, and negation mismatches specifically; it is not a
  general correctness guarantee. Raise `tau` if a wrong answer served from cache is
  unacceptable in your setting; the tradeoff against hit rate is in `data/curve.json`.
- **Refusal policy as the cache boundary.** `isCacheable` keeps tool use, streaming, explicit
  `timeSensitive`/`noCache` calls, empty input, text matching the frozen time-sensitive regex,
  and detected PII (email, phone, UUID, LinkedIn URL, and several API-key/token shapes) out of
  the cache, for both lookup and storage. A call that should never be cached needs to either
  match one of those signals or set `noCache: true` explicitly; the pattern list is fixed and
  documented in `protocol/cache-rules.json`, not exhaustive.
- **PII in committed data.** Everything under `protocol/` and `data/` is scanned by `audit
  pii-sweep` before it can be considered safe to commit. The committed paraphrase set is
  hand-written and contains no real user data.
- **The local model.** `model fetch` is the one command that reaches the network; it downloads
  `Xenova/all-MiniLM-L6-v2` and records a file-hash fingerprint in `data/run-state.json`. Every
  other command runs offline against the cached weights. `audit embedding-audit` re-embeds a
  seeded sample and checks cosine similarity to the committed vectors stays at or above 0.9999,
  which would catch a swapped or corrupted model file.
- **Spend.** Cache misses fall through to `callLlm` (`@portfolio-builds/shared`), which never
  throws, is ledgered, and defaults to mock mode (`PB_SPEND_CAP_USD = 0`, no real call) unless
  the cap is raised explicitly.

## Out of scope

- The content of responses your application chooses to cache. This tool caches what you give
  it; it does not vet the response for correctness or safety before storing it.
- The SQLite file backing `Store`. It holds embeddings, response text, and usage counts for
  whatever you cache; treat it with the same access controls you'd give the underlying LLM
  traffic.
