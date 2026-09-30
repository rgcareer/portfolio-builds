# Spec: @rgcareer/semantic-cache (bin `semcache`, npm script `semcache`)

Build under `packages/semantic-cache/`. Read `tasks/conventions.md` first. Import shared from
`@portfolio-builds/shared`. Tests first. The headline run is $0 (local embeddings).

## What it is
A cache in front of `callLlm` with an exact-hash tier and a local-embedding (MiniLM) similarity tier. It
refuses tool-use / streaming / time-sensitive / PII calls, scopes by tenant namespace, and PUBLISHES its own
hit-rate and false-hit curve against a hand-labelled near-miss set — the honest number nobody else ships.

## Files
- `protocol/cache-rules.json` — model `Xenova/all-MiniLM-L6-v2`, dtype fp32, mean pooling, normalize true;
  namespace def; refusal rules incl. the time regex `\b(today|now|latest|current|yesterday|tomorrow|this
  (week|month|year))\b|\d{4}-\d{2}-\d{2}` and the PII rule; guard rules (numeric-token set equality,
  identifier regex `#?\w*\d\w*`, negation words); grid τ 0.70..0.99 step 0.01; `shipped_tau:0.90`;
  ttl_default_ms; max_entries_default; headline_template; not_measured. YOU write it.
- `protocol/paraphrase-set.json` — 40 intents. Each: `{id, domain, base:{template, slots:{...vocab...}},
  paraphrases:[3 templates, same intent], negatives:[3 of {kind:'slot-swap'|'polarity'|'entity', template}]}`.
  Author 40 realistic support/dev/ops intents (order confirmations, cancellations, refunds, status lookups,
  password resets, config questions, etc.). Negatives must differ from the base in EXACTLY one slot value
  ("Q3"→"Q4", "#4471"→"#4417"), a polarity flip ("cancel"→"do not cancel"), or an entity swap. Labels are
  true by construction — NO LLM authors or judges them. Slots are filled deterministically with
  `mulberry32(20260915)`.
- `src/protocol.ts` (`loadProtocol`, hash over both files) · `src/cacheable.ts` (`isCacheable(spec, rules)`
  → `{cacheable, reason}`) · `src/guards.ts` (`slotGuard(query, candidate, rules)` → `{veto, reason}`) ·
  `src/similarity.ts` (`cosine(a,b)`, `topK`) · `src/embedder.ts` (`class Embedder.load({modelId, cacheDir,
  allowRemote, dtype})`, `embed(texts)→Float32Array[]`, `fingerprint()`; and a `FakeEmbedder` that maps text
  to a deterministic unit vector for tests) · `src/store.ts` (`node:sqlite`: `entries(id, tenant, model,
  system_sha256, mock, exact_key UNIQUE, text_sha256, text_chars, embedding BLOB, response, usage_json,
  created_at, expires_at, hits, last_hit_at)` + `events(id, ts, tenant, model, decision, reason, similarity,
  matched_id, exact_key)`; namespace index; TTL purge; LRU) · `src/cache.ts` (`class SemanticCache
  {lookup(ns, exactKey, text), store(...), purge(ns?), stats(ns?)}`; namespace = `(tenant, model,
  system_sha256, mock)`; exactKey = `sha256Canonical({model, system, user, maxTokens})`; store only
  `error===null`, never PII in text/response) · `src/wrapper.ts` (`cachedCallLlm(spec, opts & {cache})`:
  exact tier → embed → semantic tier (cosine ≥ τ AND slotGuard passes) → else `callLlm`; emits a
  TrafficRecord with `cache.decision` and `avoidedUsage`) · `src/labelset.ts` (`expandParaphraseSet(protocol)`
  → `LabeledItem[]`) · `src/sweep.ts` (`sweep(items, vecs, grid, guards)` → curve points; hit = paraphrase
  matches its base ≥ τ with guard pass; falseHit = negative matches its base ≥ τ with guard pass; Wilson on
  both) · `src/report.ts`, `src/index.ts`, `src/cli.ts`.
- `data/embeddings.json` (float32 base64, committed), `data/{run-state,curve,run-meta}.json`, `.model-cache/`
  (gitignored). tsup marks `@huggingface/transformers` external.

## Headline (template in cache-rules.json; render via `renderHeadline`; $0)
"On {nItems} hand-written queries ({nBase} intents, each with {kPara} paraphrases and {kNeg} near-miss
negatives), the local MiniLM cache at its shipped threshold {tau} served {kHit} of {nPara} paraphrases from
cache ({hitPct}%, 95% Wilson CI {hitLo}-{hitHi}%) and wrongly served {kFp} of {nNeg} near-misses ({fpPct}%,
CI {fpLo}-{fpHi}%); embeddings cost $0."
Determinism: commit embeddings as base64 float32; `sweep`/`repro` are pure functions of embeddings.json +
protocol, bit-for-bit offline.

## CLI (citty; `--json`; exit 0/1/2)
`model fetch` (the ONE egress override; writes fingerprint to run-state) · `embed` (protocol set →
embeddings.json) · `sweep` (→ curve.json + run-meta.json) · `headline` · `repro` · `stats --db` · `lookup
--db --tenant --model --system-file --text` · `purge --db [--tenant]`.

## Tests (name each; ≥34; FakeEmbedder for all but the embedder test)
cacheable: refuses tools, stream, timeSensitive, noCache, time-regex on user text, PII in user, empty user;
accepts a plain spec (7). guards: veto on differing numeric tokens, identifiers, polarity; pass on pure
paraphrase (4). similarity: identical→1, orthogonal→0, requires normalized input (3). store: namespace
isolation across tenants and system prompts; TTL expiry; LRU at max; events row per lookup; mock entries
never served to real calls. cache: exact tier hits before embedding (FakeEmbedder embed-count 0); semantic
hit above τ; miss below; guard veto logged. wrapper: miss→callLlm mock→stored; identical call→hit, no new
ledger row, TrafficRecord with avoidedUsage; non-cacheable bypasses with reason; error result never stored.
labelset: deterministic; ≥3 paraphrases & ≥3 negatives per intent; no duplicate text; each negative differs
in exactly one slot/polarity/entity; `assertNoPii` over all texts. sweep: exact hit/FP/Wilson on synthetic
vectors; hit rate non-increasing in τ; guards-on FP ≤ guards-off FP. embedder (`it.skipIf(!modelCached)`):
384 dims, unit norm, deterministic across two calls, fingerprint has per-file sha256. protocol: hash covers
both files. cli: `--json`, exit codes.

## Repro & audits (main session wires tests.json)
`semcache repro` re-derives curve.json + run-meta.json from embeddings.json offline, bit-for-bit. Provide the
logic for: protocol-frozen (hash + commit precedes embeddedAt), pii-sweep, readme-headline, embedding-audit
(re-embed 10 seeded items with the local model, cosine to committed ≥ 0.9999; passes with a note when
`.model-cache` is absent).

## Build order
protocol + paraphrase set (write & freeze first) → cacheable/guards/similarity → store/cache with FakeEmbedder
→ wrapper → labelset/sweep/headline/repro → CLI → Embedder + `model fetch` (main session does the real fetch
+ embed + sweep later, one override). Use `find-docs` to confirm the transformers.js v4 API
(`pipeline('feature-extraction', modelId, {dtype})`, `env.cacheDir`, `env.allowRemoteModels`) before writing
embedder.ts. Return blocked on any measured-number ambiguity.
