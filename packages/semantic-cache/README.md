# semantic-cache

A drop-in cache in front of an LLM call, with an exact-hash tier and a local-embedding
similarity tier underneath it. It publishes its own hit-rate and false-hit curve against a
labelled near-miss set, so the threshold it ships with is a measured tradeoff, not a guess.

## Result

> On 280 hand-written queries (40 intents, each with 3 paraphrases and 3 near-miss negatives), the local MiniLM cache at its shipped threshold 0.90 served 74 of 120 paraphrases from cache (61.7%, 95% Wilson CI 52.7-69.9%) and wrongly served 8 of 120 near-misses (6.7%, CI 3.4-12.6%); embeddings cost $0.

Rendered by:

```
$ node --import tsx src/cli.ts headline
headline: On 280 hand-written queries (40 intents, each with 3 paraphrases and 3 near-miss negatives), the local MiniLM cache at its shipped threshold 0.90 served 74 of 120 paraphrases from cache (61.7%, 95% Wilson CI 52.7-69.9%) and wrongly served 8 of 120 near-misses (6.7%, CI 3.4-12.6%); embeddings cost $0.
```

from the committed `data/run-meta.json` (protocol hash `2f6fbd64…`, generated 2026-09-16T02:20:44.489Z).
The `readme-headline` audit checks that this sentence and the generator's output stay identical.

**Read this strictly.** The 40 intents and their paraphrases and negatives are hand-written by
me, not sampled from real traffic, and the embedding model is fixed at `Xenova/all-MiniLM-L6-v2`.
The curve says what this model does on this labelled set, not what it will do on your traffic.

## What it does / measures

Given a query and a namespace (tenant, model, a hash of the system prompt, and a mock flag), a
lookup runs two tiers before ever reaching the real LLM call:

1. **Exact tier.** A hash of `{model, system, user, maxTokens}` checked against the store. No
   embedding call happens on this path at all.
2. **Semantic tier.** The query is embedded with the local MiniLM model and compared by cosine
   similarity against every live (non-expired) entry in the namespace. The closest candidate
   above the shipped threshold (`tau = 0.90`) is a hit, unless a slot guard vetoes it.

Everything a call needs to be eligible in the first place is checked by `isCacheable` before
any of that: tool use, streaming, an explicit `timeSensitive` or `noCache` flag, an empty user
message, text matching a time-sensitive pattern (`today`, `latest`, a bare date, and so on), or
detected PII all bypass the cache entirely, both for lookup and for storage.

The published curve measures two things against the labelled paraphrase set, at every
threshold from 0.70 to 0.99 in steps of 0.01:

- **Hit rate**: of the 120 genuine paraphrases (3 per intent, 40 intents), how many the cache
  serves at that threshold.
- **False-hit rate**: of the 120 near-miss negatives (a swapped slot value, a swapped entity, or
  a negated verb, 3 per intent), how many the cache wrongly serves.

## Quick start

```bash
npx tsx src/cli.ts model fetch          # downloads MiniLM once (the one sanctioned egress step)
npx tsx src/cli.ts embed                # embeds the paraphrase set into data/embeddings.json
npx tsx src/cli.ts sweep                # sweeps tau, writes data/curve.json + data/run-meta.json
npx tsx src/cli.ts headline             # prints the rendered headline
```

`model fetch` is the only command that touches the network. Everything after it runs offline
against the committed `.model-cache` and `data/embeddings.json`.

## CLI

| Command | Does |
|---|---|
| `model fetch [--cache-dir]` | Downloads and caches the local MiniLM model; writes `data/run-state.json`. |
| `embed [--cache-dir] [--out]` | Embeds the frozen paraphrase set into `data/embeddings.json`. |
| `sweep [--embeddings] [--curve-out] [--run-meta-out]` | Sweeps the tau grid against committed embeddings, writes `curve.json` and `run-meta.json`. |
| `headline [--run-meta]` | Prints the rendered headline from a committed `run-meta.json`. |
| `repro [--embeddings] [--curve] [--run-meta]` | Re-derives `curve.json` and `run-meta.json` from committed embeddings and diffs against what is committed. |
| `audit protocol-frozen [--embeddings]` | Checks the protocol has not changed since embedding, and was frozen no later than `embeddedAt`. |
| `audit pii-sweep` | Scans every committed `protocol/` and `data/` JSON file for PII shapes. |
| `audit readme-headline [--run-meta]` | Checks `README.md` contains the exact rendered headline, byte for byte. |
| `audit embedding-audit [--embeddings] [--cache-dir]` | Re-embeds 10 seeded items with the local model; cosine to committed must be ≥ 0.9999. Passes with a note when `.model-cache` is absent. |
| `stats --db [--tenant --model --system-file]` | Prints entry and event counts for a cache database. |
| `lookup --db --tenant --model --system-file --text` | Looks up one query against the cache (exact tier, then semantic tier). |
| `purge --db [--tenant]` | Purges expired entries from a cache database. |

There is no `report` command; `headline` and the `--json` flag on any command are the
machine-readable surfaces.

## Library API

```ts
import {
  cachedCallLlm, exactKeyFor,
  SemanticCache, Store,
  isCacheable, slotGuard, cosine, topK,
  Embedder, FakeEmbedder,
  loadProtocol, expandParaphraseSet, sweep, buildRunMeta,
} from '@rgcareer/semantic-cache';
```

`cachedCallLlm(spec, opts)` is the drop-in front for `callLlm`. A non-cacheable spec bypasses
straight through. A cacheable spec checks the exact tier, then the semantic tier, before ever
calling the real (or mocked) LLM, and stores a successful result for next time. Every call
returns a `TrafficRecord` carrying the cache decision, the reason, and (on a hit) the usage
that call avoided spending, so the cache's savings can be tallied from the same traffic log
as everything else.

## How it decides

A candidate above the similarity threshold still passes through `slotGuard` before it counts
as a hit. Embeddings alone cannot distinguish "confirm order #4471" from "confirm order
#8822", "cancel order #4471" from "confirm order #4471", or "confirm order #4471" from
"confirm reservation #4471": all three pairs sit close together in embedding space because
they share almost every word. The guard vetoes a match whenever the query and the candidate
differ in:

- a numeric token (`numeric-mismatch`),
- an identifier-shaped token, `#4471` vs `#8822` (`identifier-mismatch`), or
- the presence of a negation word from a fixed list: not, no, never, don't, won't, without, and
  their contractions (`polarity-mismatch`).

This is exactly how the paraphrase set's three negative kinds (slot-swap, entity, polarity)
are constructed to differ from their base, so the guard is built to catch what cosine
similarity structurally cannot.

## Reproduce

```bash
node --import tsx src/cli.ts repro
```

```
$ node --import tsx src/cli.ts repro --json
{"match":true,"curveMatch":true,"runMetaMatch":true}
```

`repro` re-derives `curve.json` and `run-meta.json` from the committed `data/embeddings.json`
and the frozen protocol, entirely offline, and compares the result to what is committed byte
for byte (excluding `generatedAt`). The command above was run against this checkout and its
output is pasted verbatim.

## Cost

```
$ node --import tsx src/cli.ts audit embedding-audit --json
{"ok":true,"reasons":[],"minCosine":0.9999999999998705,"sampled":10}
```

Embedding the 280-item paraphrase set costs $0: MiniLM runs locally, once fetched. `run-meta.json`
records `costUsd: 0` for that reason, not because spend was capped. A live `cachedCallLlm` still
goes through `callLlm` (`@portfolio-builds/shared`) for every LLM call it makes on a cache miss,
which respects `PB_SPEND_CAP_USD` and defaults to mock mode ($0, no network) like every other
package here.

## What is NOT measured

Carried verbatim from `protocol/cache-rules.json`:

- Multi-turn conversations: each lookup is scored independently of prior turns.
- Cross-tenant leakage under adversarial attack: namespace isolation is structural, not
  adversarially tested.
- Embedding drift across model versions or dtypes other than fp32.
- Production traffic distribution: the curve is measured on a hand-written paraphrase set, not
  live traffic.
- Latency of the embedding or lookup path.

## Failure modes

- The paraphrase set is hand-written by me. A different domain, a different writing style, or
  a longer query could sit anywhere on the curve, not necessarily near 61.7%/6.7%.
- The slot guard is regex-based against a fixed pattern list (`numeric_token_regex`,
  `identifier_regex`, three negation forms). A near-miss that does not change a number, an
  identifier, or use one of the listed negation words can still pass the guard.
- A namespace's cache grows unbounded between `purge` calls except for the LRU eviction at
  `max_entries_default` (5000); nothing purges expired entries automatically.
- `isCacheable`'s time-sensitive check is one regex (`today`, `now`, `latest`, `current`,
  `yesterday`, `tomorrow`, a bare `this week/month/year`, or an ISO date). Time-sensitive text
  that does not match that pattern is not refused.

## Security

See [SECURITY.md](./SECURITY.md).

## License

MIT
