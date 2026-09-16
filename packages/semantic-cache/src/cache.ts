// SemanticCache ties the store, embedder, similarity, and guard tiers together into one
// lookup/store surface. Tier order matters for cost: exact-key match first (no embedding
// call at all), THEN embed and search the namespace's live entries by cosine similarity,
// THEN — only for the best candidate at or above tau — the slot guard gets the final veto.

import { sha256Hex } from '@portfolio-builds/shared';
import { cosine } from './similarity';
import { slotGuard } from './guards';
import { Store, type Namespace, type EntryUsage, type StoredEntry, type CacheDecision } from './store';
import type { EmbedderLike } from './embedder';
import type { CacheRules } from './protocol';

export interface LookupResult {
  decision: CacheDecision;
  reason: string;
  entry: StoredEntry | null;
  similarity: number | null;
}

export interface SemanticCacheOptions {
  store: Store;
  embedder: EmbedderLike;
  rules: CacheRules;
  /** Similarity threshold; defaults to the protocol's shipped_tau. */
  tau?: number;
}

export class SemanticCache {
  // Named `db`, not `store`, to avoid colliding with this class's own store() method below.
  readonly db: Store;
  readonly embedder: EmbedderLike;
  readonly rules: CacheRules;
  readonly tau: number;

  constructor(opts: SemanticCacheOptions) {
    this.db = opts.store;
    this.embedder = opts.embedder;
    this.rules = opts.rules;
    this.tau = opts.tau ?? opts.rules.sweep.shipped_tau;
  }

  async lookup(ns: Namespace, exactKey: string, text: string, now: string = new Date().toISOString()): Promise<LookupResult> {
    const exact = this.db.getByExactKey(ns, exactKey);
    if (exact && (exact.expiresAt === null || exact.expiresAt > now)) {
      this.db.touchHit(exact.id, now);
      this.db.recordEvent({ ts: now, tenant: ns.tenant, model: ns.model, decision: 'hit', reason: 'exact', similarity: null, matchedId: exact.id, exactKey });
      return { decision: 'hit', reason: 'exact', entry: exact, similarity: null };
    }

    const candidates = this.db.listNamespace(ns, now);
    if (candidates.length === 0) {
      this.db.recordEvent({ ts: now, tenant: ns.tenant, model: ns.model, decision: 'miss', reason: 'empty-namespace', similarity: null, matchedId: null, exactKey });
      return { decision: 'miss', reason: 'empty-namespace', entry: null, similarity: null };
    }

    const [qvec] = await this.embedder.embed([text]);
    let best: { entry: StoredEntry; sim: number } | null = null;
    for (const candidate of candidates) {
      const sim = cosine(qvec!, candidate.embedding);
      if (!best || sim > best.sim) best = { entry: candidate, sim };
    }

    if (!best || best.sim < this.tau) {
      const sim = best?.sim ?? null;
      this.db.recordEvent({ ts: now, tenant: ns.tenant, model: ns.model, decision: 'miss', reason: 'below-threshold', similarity: sim, matchedId: best?.entry.id ?? null, exactKey });
      return { decision: 'miss', reason: 'below-threshold', entry: null, similarity: sim };
    }

    const guard = slotGuard(text, best.entry.text, this.rules);
    if (guard.veto) {
      const reason = `guard-veto:${guard.reason}`;
      this.db.recordEvent({ ts: now, tenant: ns.tenant, model: ns.model, decision: 'miss', reason, similarity: best.sim, matchedId: best.entry.id, exactKey });
      return { decision: 'miss', reason, entry: null, similarity: best.sim };
    }

    this.db.touchHit(best.entry.id, now);
    this.db.recordEvent({ ts: now, tenant: ns.tenant, model: ns.model, decision: 'hit', reason: 'semantic', similarity: best.sim, matchedId: best.entry.id, exactKey });
    return { decision: 'hit', reason: 'semantic', entry: best.entry, similarity: best.sim };
  }

  async store(
    ns: Namespace,
    exactKey: string,
    text: string,
    response: string,
    usage: EntryUsage | null,
    ttlMs?: number,
    now: string = new Date().toISOString(),
  ): Promise<StoredEntry> {
    const [vec] = await this.embedder.embed([text]);
    const ttl = ttlMs ?? this.rules.cache.ttl_default_ms;
    const expiresAt = ttl > 0 ? new Date(Date.parse(now) + ttl).toISOString() : null;
    const entry = this.db.insertEntry({
      tenant: ns.tenant,
      model: ns.model,
      systemSha256: ns.systemSha256,
      mock: ns.mock,
      exactKey,
      text,
      textSha256: sha256Hex(text),
      textChars: text.length,
      embedding: vec!,
      response,
      usage,
      createdAt: now,
      expiresAt,
    });
    this.db.enforceLru(ns, this.rules.cache.max_entries_default);
    return entry;
  }

  purge(now: string = new Date().toISOString(), ns?: Namespace): number {
    return this.db.purgeExpired(now, ns);
  }

  stats(ns: Namespace, now: string = new Date().toISOString()): { entries: number; hits: number; events: number } {
    const entries = this.db.listNamespace(ns, now);
    return {
      entries: entries.length,
      hits: entries.reduce((sum, e) => sum + e.hits, 0),
      events: this.db.countEvents(),
    };
  }
}
