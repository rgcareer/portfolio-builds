import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { z } from 'zod';
import { sha256Canonical } from '@skillcheck/core';

// Rule-pack schema (zod, parse-then-validate). A malformed pack is an INVALID RULESET —
// the CLI exits 2 and never produces partial results (agenteval's validity-vs-findings
// separation applied to the ruleset itself). ruleset_hash is computed over the
// canonicalized parsed packs, so YAML whitespace / key-order edits do not change it but
// semantic edits (a new pattern, a severity change) do.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RULE_KINDS = ['regex', 'codepoints', 'mixed_script'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

const CODEPOINT_RE = /^U\+[0-9A-Fa-f]{1,6}(?:-U\+[0-9A-Fa-f]{1,6})?$/;

const ExamplesSchema = z.strictObject({
  match: z.array(z.string()).default([]),
  no_match: z.array(z.string()).default([]),
});

const RuleSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Z]{2,5}-\d{3}$/, 'rule id must look like PI-001'),
    title: z.string().min(1),
    severity: z.enum(SEVERITIES),
    kind: z.enum(RULE_KINDS),
    applies_to: z.array(z.string()).default(['**/*']),
    patterns: z.array(z.string()).optional(),
    flags: z.string().regex(/^[ims]*$/, 'flags may only contain i, m, s').optional(),
    codepoints: z.array(z.string().regex(CODEPOINT_RE, 'codepoint must be U+XXXX or U+XXXX-U+YYYY')).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    context_lines: z.number().int().min(0).max(5).default(1),
    notes: z.string().optional(),
    message: z.string().optional(),
    examples: ExamplesSchema.default({ match: [], no_match: [] }),
  })
  .refine((r) => r.kind !== 'regex' || (r.patterns !== undefined && r.patterns.length > 0), {
    message: 'a regex rule requires a non-empty `patterns` list',
  })
  .refine((r) => r.kind !== 'codepoints' || (r.codepoints !== undefined && r.codepoints.length > 0), {
    message: 'a codepoints rule requires a non-empty `codepoints` list',
  });

const PackSchema = z.strictObject({
  pack: z.string().min(1),
  version: z.number().int().positive(),
  rules: z.array(RuleSchema).min(1),
});

export type Rule = z.infer<typeof RuleSchema>;
export type Pack = z.infer<typeof PackSchema>;
export type RuleWithPack = Rule & { pack: string };

export class RulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesetError';
  }
}

export interface LoadedRuleset {
  packs: Pack[];
  rules: RuleWithPack[];
  rulesetHash: string;
}

/** Parse + validate one pack's YAML text. Throws RulesetError on any problem. */
export function parsePack(yamlText: string, filename: string): Pack {
  let doc: unknown;
  try {
    doc = yamlLoad(yamlText);
  } catch (e) {
    throw new RulesetError(`${filename}: YAML parse error: ${(e as Error).message}`);
  }
  const result = PackSchema.safeParse(doc);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') ?? '';
    throw new RulesetError(`${filename}: invalid rule pack${path ? ` at [${path}]` : ''}: ${issue?.message}`);
  }
  return result.data;
}

/**
 * Load every *.yaml/*.yml pack in `dir` (sorted for determinism), enforce globally unique
 * rule ids, and compute the ruleset hash over the canonicalized parsed packs.
 */
export function loadRuleset(dir: string): LoadedRuleset {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const packs: Pack[] = [];
  const rules: RuleWithPack[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const pack = parsePack(readFileSync(join(dir, file), 'utf8'), file);
    packs.push(pack);
    for (const rule of pack.rules) {
      const prior = seen.get(rule.id);
      if (prior !== undefined) {
        throw new RulesetError(`Duplicate rule id ${rule.id} in ${file} (already defined in ${prior})`);
      }
      seen.set(rule.id, file);
      rules.push({ ...rule, pack: pack.pack });
    }
  }

  return { packs, rules, rulesetHash: sha256Canonical(packs) };
}

export interface CodepointRange {
  start: number;
  end: number;
}

/** Parse a validated codepoint spec ("U+202A" or "U+202A-U+202E") into a numeric range. */
export function parseCodepointSpec(spec: string): CodepointRange {
  const m = /^U\+([0-9A-Fa-f]{1,6})(?:-U\+([0-9A-Fa-f]{1,6}))?$/.exec(spec);
  if (!m) throw new RulesetError(`Invalid codepoint spec: ${spec}`);
  const start = parseInt(m[1]!, 16);
  const end = m[2] !== undefined ? parseInt(m[2], 16) : start;
  return { start, end };
}
