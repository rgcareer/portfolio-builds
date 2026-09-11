// The [SIMULATED] convention (evalcard / agenteval, Victoria 4.0 section 6/7): anything an
// LLM judged rather than a tool measured carries independence "[SIMULATED]" and its
// confidence is hard-capped at 0.80. Such values are secondary columns only; they never
// enter a headline.

export const SIMULATED = '[SIMULATED]' as const;
export const MEASURED = 'measured' as const;
export type Independence = typeof SIMULATED | typeof MEASURED;

export const SIMULATED_CONFIDENCE_CAP = 0.8;

export function capConfidence(confidence: number, independence: Independence): number {
  const c = Math.min(1, Math.max(0, confidence));
  return independence === SIMULATED ? Math.min(c, SIMULATED_CONFIDENCE_CAP) : c;
}

export interface SimulatedValue<T> {
  value: T;
  independence: typeof SIMULATED;
  confidence: number;
  model: string;
}

export function simulated<T>(value: T, confidence: number, model: string): SimulatedValue<T> {
  return { value, independence: SIMULATED, confidence: capConfidence(confidence, SIMULATED), model };
}
