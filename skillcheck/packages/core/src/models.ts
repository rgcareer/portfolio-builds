// Model policy for Skillcheck.
//
// HARD RULE (Ryan, 2026-08-25, standing until revoked): any Opus-tier model call uses
// `claude-opus-4-8`. `claude-opus-5` is excluded EVERYWHERE — every package, every
// roster, including benchmark rosters. This module enforces it structurally: it throws
// at load if any id matching /claude-opus-5/ appears in the roster or the price table,
// so the policy cannot be silently violated by a later edit anywhere in the codebase.

export type LlmTier = 'opus' | 'sonnet' | 'haiku';

/** USD per million tokens. */
export interface ModelPrice {
  in: number;
  out: number;
}

/** The sanctioned roster. Opus-tier is pinned to 4.8. */
export const MODELS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const satisfies Record<LlmTier, string>;

/**
 * Prices ported from operation-hired/server/services/llm.js, with the `claude-opus-5`
 * row deliberately DROPPED (it was present in the source at line 31). Unknown models
 * fall back to Opus-tier rates, matching the OH gateway.
 */
export const LLM_PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

/** The banned pattern. Any occurrence in a roster or price table is a fatal error. */
export const BANNED_MODEL_RE = /claude-opus-5/;

/**
 * Throw if any id matching the banned pattern appears in `roster` or `prices`.
 * Exported with the real constants as defaults so it runs at module load, and takes
 * arguments so tests can inject a polluted roster to prove the guard fires.
 */
export function assertModelPolicy(
  roster: Record<string, string> = MODELS,
  prices: Record<string, ModelPrice> = LLM_PRICES,
): void {
  const offenders: string[] = [];
  for (const id of Object.values(roster)) if (BANNED_MODEL_RE.test(id)) offenders.push(`roster:${id}`);
  for (const id of Object.keys(prices)) if (BANNED_MODEL_RE.test(id)) offenders.push(`prices:${id}`);
  if (offenders.length > 0) {
    throw new Error(
      `Model policy violation: claude-opus-5 is banned everywhere (use claude-opus-4-8). ` +
        `Offending ids: ${offenders.join(', ')}`,
    );
  }
}

// Enforced at load: importing this module (directly or via @skillcheck/core) runs the check.
assertModelPolicy();

export function priceFor(model: string): ModelPrice {
  // The opus entry always exists, so the fallback is non-null.
  return LLM_PRICES[model] ?? LLM_PRICES[MODELS.opus]!;
}

export interface UsageTokens {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
}

/**
 * Cost in USD from usage fields. All three input fields (fresh, cache-read,
 * cache-creation) are summed at the input rate — matching the OH accounting exactly.
 */
export function computeCostUsd(model: string, usage: UsageTokens): number {
  const price = priceFor(model);
  const inTok = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheCreation ?? 0);
  const outTok = usage.output ?? 0;
  return (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
}
