// Slot guards: a cheap, deterministic textual veto that runs AFTER the embedding similarity
// tier clears threshold. Near-miss negatives (a slot value, an identifier, or a polarity
// word swapped) can sit very close to their base in embedding space; the guard catches what
// cosine similarity structurally cannot: two texts that are "close" but not the SAME request.

import type { CacheRules } from './protocol';

export type GuardVetoReason = 'numeric-mismatch' | 'identifier-mismatch' | 'polarity-mismatch';

export interface GuardResult {
  veto: boolean;
  reason: GuardVetoReason | null;
}

function extractTokenSet(text: string, pattern: string): Set<string> {
  const re = new RegExp(pattern, 'g');
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[0]);
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function extractNegationWords(text: string, negationWords: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const word of negationWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(text)) found.add(word.toLowerCase());
  }
  return found;
}

/**
 * Vetoes a candidate match when the query and candidate differ in a numeric token, an
 * identifier-shaped token, or the presence of a negation word — the three ways the
 * paraphrase-set's negatives are constructed to differ from their base (slot-swap,
 * entity, polarity), so this is exactly what catches them once embeddings alone don't.
 */
export function slotGuard(query: string, candidate: string, rules: CacheRules): GuardResult {
  const numQ = extractTokenSet(query, rules.guards.numeric_token_regex);
  const numC = extractTokenSet(candidate, rules.guards.numeric_token_regex);
  if (!setsEqual(numQ, numC)) return { veto: true, reason: 'numeric-mismatch' };

  const idQ = extractTokenSet(query, rules.guards.identifier_regex);
  const idC = extractTokenSet(candidate, rules.guards.identifier_regex);
  if (!setsEqual(idQ, idC)) return { veto: true, reason: 'identifier-mismatch' };

  const negQ = extractNegationWords(query, rules.guards.negation_words);
  const negC = extractNegationWords(candidate, rules.guards.negation_words);
  if (!setsEqual(negQ, negC)) return { veto: true, reason: 'polarity-mismatch' };

  return { veto: false, reason: null };
}
