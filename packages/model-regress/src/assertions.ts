// The assertion library. `exact-json` (canonical equality) is the headline binary; every
// other measured assertion is a secondary column. `rubric` is the one LLM-judged assertion:
// it REFUSES to run unless the caller opts in with allowSimulated, and when it does it is
// marked [SIMULATED], its confidence is capped at 0.80, and it is never headline-eligible.

import {
  SIMULATED,
  capConfidence,
  stableStringify,
  type Independence,
} from '@portfolio-builds/shared';

export type Assertion =
  | { kind: 'json-parse' }
  | { kind: 'json-schema' }
  | { kind: 'exact-json'; expected: unknown }
  | { kind: 'contains'; value: string }
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'cost-usd-max'; maxUsd: number }
  | { kind: 'latency-ms-max'; maxMs: number }
  | { kind: 'rubric'; criterion: string; allowSimulated?: boolean; score?: number; threshold?: number; model?: string };

export type AssertionKind = Assertion['kind'];

/** What an assertion observes: the model's text plus the measured cost/latency of the call. */
export interface AssertionOutput {
  content: string | null;
  costUsd?: number;
  latencyMs?: number;
}

export interface AssertionResult {
  kind: AssertionKind;
  pass: boolean;
  detail?: string;
  independence?: Independence;
  confidence?: number;
  headlineEligible: boolean;
}

/**
 * All maximal top-level `{…}` substrings that parse as JSON, in order. String contents and
 * escapes are respected, and code fences (```json … ```) are ignored, so a fenced object and
 * a bare object both count as one.
 */
export function topLevelJsonObjects(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const objs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const slice = cleaned.slice(start, i + 1);
          try {
            objs.push(JSON.parse(slice));
          } catch {
            /* not valid JSON — not a top-level object */
          }
          start = -1;
        }
      }
    }
  }
  return objs;
}

/** The first balanced JSON object (the frozen parse_rule), or null when there is none. */
export function parseFirstJsonObject(text: string): unknown | null {
  const objs = topLevelJsonObjects(text);
  return objs.length > 0 ? objs[0]! : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Structural check for the extraction schema. Returns the list of problems (empty = valid). */
export function schemaIssues(obj: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(obj)) return ['not an object'];
  const o = obj;
  if (typeof o['id'] !== 'string') issues.push('id must be a string');
  if (typeof o['date'] !== 'string') issues.push('date must be a string');
  if (typeof o['total_cents'] !== 'number' || !Number.isInteger(o['total_cents'])) issues.push('total_cents must be an integer');
  if (typeof o['paid'] !== 'boolean') issues.push('paid must be a boolean');
  if (typeof o['status'] !== 'string') issues.push('status must be a string');
  if (!Array.isArray(o['items'])) issues.push('items must be an array');
  else {
    o['items'].forEach((li, i) => {
      if (!isRecord(li)) {
        issues.push(`items[${i}] must be an object`);
        return;
      }
      if (typeof li['name'] !== 'string') issues.push(`items[${i}].name must be a string`);
      if (typeof li['qty'] !== 'number') issues.push(`items[${i}].qty must be a number`);
      if (typeof li['unit_cents'] !== 'number') issues.push(`items[${i}].unit_cents must be a number`);
    });
  }
  return issues;
}

function measured(kind: AssertionKind, pass: boolean, detail?: string): AssertionResult {
  return detail === undefined ? { kind, pass, headlineEligible: true } : { kind, pass, detail, headlineEligible: true };
}

export function runAssertion(a: Assertion, out: AssertionOutput): AssertionResult {
  const content = out.content;
  switch (a.kind) {
    case 'json-parse':
      if (content === null) return measured(a.kind, false, 'no content');
      return measured(a.kind, topLevelJsonObjects(content).length === 1);
    case 'json-schema': {
      if (content === null) return measured(a.kind, false, 'no content');
      const obj = parseFirstJsonObject(content);
      if (obj === null) return measured(a.kind, false, 'no JSON object');
      const issues = schemaIssues(obj);
      return measured(a.kind, issues.length === 0, issues[0]);
    }
    case 'exact-json': {
      if (content === null) return measured(a.kind, false, 'no content');
      const obj = parseFirstJsonObject(content);
      if (obj === null) return measured(a.kind, false, 'no JSON object');
      const pass = stableStringify(obj) === stableStringify(a.expected);
      return measured(a.kind, pass);
    }
    case 'contains':
      return measured(a.kind, content !== null && content.includes(a.value));
    case 'regex': {
      if (content === null) return measured(a.kind, false, 'no content');
      const re = new RegExp(a.pattern, a.flags);
      return measured(a.kind, re.test(content));
    }
    case 'cost-usd-max':
      return measured(a.kind, (out.costUsd ?? 0) <= a.maxUsd);
    case 'latency-ms-max':
      return measured(a.kind, (out.latencyMs ?? 0) <= a.maxMs);
    case 'rubric': {
      if (!a.allowSimulated) {
        throw new Error('rubric assertion is LLM-judged; it refuses to run without allowSimulated (it can never enter a headline)');
      }
      const score = a.score ?? 0;
      const threshold = a.threshold ?? 0.5;
      const confidence = capConfidence(score, SIMULATED);
      return {
        kind: a.kind,
        pass: score >= threshold,
        independence: SIMULATED,
        confidence,
        headlineEligible: false,
        detail: a.criterion,
      };
    }
  }
}
