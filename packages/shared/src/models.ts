// Model policy for every portfolio-builds package.
//
// Provenance: vendored 2026-09-10 from skillcheck/packages/core/src/models.ts (prices
// originally from operation-hired/server/services/llm.js with the claude-opus-5 row dropped).
//
// HARD RULE (Ryan, 2026-08-25, standing until revoked): any Opus-tier call uses
// `claude-opus-4-8`. `claude-opus-5` is excluded EVERYWHERE, including benchmark rosters.
// Enforced structurally: this module throws at load if any banned id appears in the roster
// or price table, so the policy cannot be silently violated by a later edit.

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

export const LLM_PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

/** The banned pattern. Any occurrence in a roster, price table, or call spec is fatal. */
export const BANNED_MODEL_RE = /claude-opus-5/;

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

// Enforced at load: importing this module (directly or via the package index) runs the check.
assertModelPolicy();

export function isBannedModel(id: string): boolean {
  return BANNED_MODEL_RE.test(id);
}

export function priceFor(model: string): ModelPrice {
  return LLM_PRICES[model] ?? LLM_PRICES[MODELS.opus]!;
}

export interface UsageTokens {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
}

/**
 * Cost in USD from usage fields. All three input fields (fresh, cache-read, cache-creation)
 * are summed at the input rate, matching the Operation Hired accounting exactly.
 */
export function computeCostUsd(model: string, usage: UsageTokens): number {
  const price = priceFor(model);
  const inTok = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheCreation ?? 0);
  const outTok = usage.output ?? 0;
  return (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
}

/**
 * Conservative pre-call cost ceiling used by the spend cap: input estimated at 1 token per
 * 3 characters (over-estimate), output at the requested max_tokens.
 */
export function estimateCostCeilingUsd(model: string, inputChars: number, maxOutputTokens: number): number {
  return computeCostUsd(model, { input: Math.ceil(inputChars / 3), output: maxOutputTokens });
}
