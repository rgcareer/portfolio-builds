// @rgcareer/semantic-cache — public surface.

export { loadProtocol, PKG_ROOT, PROTOCOL_DIR, DATA_DIR } from './protocol';
export type { CacheRules, ParaphraseSet, IntentDef, NegativeTemplate, Protocol, TauGrid } from './protocol';

export { isCacheable } from './cacheable';
export type { CacheableSpec, CacheableReason, CacheableResult } from './cacheable';

export { slotGuard } from './guards';
export type { GuardResult, GuardVetoReason } from './guards';

export { cosine, topK } from './similarity';
export type { Scored } from './similarity';

export { Embedder, FakeEmbedder } from './embedder';
export type { EmbedderLike, EmbedderOptions, EmbedderFingerprint } from './embedder';

export { Store } from './store';
export type { Namespace, NewEntry, StoredEntry, EntryUsage, NewEvent, CacheDecision } from './store';

export { SemanticCache } from './cache';
export type { LookupResult, SemanticCacheOptions } from './cache';

export { cachedCallLlm, exactKeyFor } from './wrapper';
export type { CachedCallOptions, CachedCallResult } from './wrapper';

export { expandParaphraseSet } from './labelset';
export type { LabeledItem, ItemRole, NegativeKind } from './labelset';

export { sweep, tauGrid } from './sweep';
export type { SweepPoint } from './sweep';

export { buildRunMeta } from './report';
export type { RunMeta } from './report';

export { protocolFrozenAudit, piiSweep, readmeHeadlineAudit, embeddingAuditCompare } from './audit';
export type { AuditResult, EmbedMeta, PiiViolation, PiiSweepResult, EmbeddingAuditSample, EmbeddingAuditResult } from './audit';
