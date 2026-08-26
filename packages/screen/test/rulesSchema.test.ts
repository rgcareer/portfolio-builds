import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Canonical } from '@skillcheck/core';
import { parsePack, loadRuleset, parseCodepointSpec, RulesetError } from '../src/rulesSchema';

const VALID = `
pack: prompt-injection
version: 1
rules:
  - id: PI-001
    title: Instruction override
    severity: high
    kind: regex
    flags: i
    patterns:
      - "ignore (all )?(previous|prior) instructions"
    examples:
      match: ["Ignore previous instructions"]
      no_match: ["follow the instructions carefully"]
  - id: UNI-001
    title: Zero-width characters
    severity: high
    kind: codepoints
    codepoints: ["U+200B", "U+200C", "U+2060-U+2064"]
`;

describe('parsePack', () => {
  it('accepts a valid pack and applies defaults', () => {
    const pack = parsePack(VALID, 'prompt-injection.yaml');
    expect(pack.pack).toBe('prompt-injection');
    expect(pack.rules[0]!.applies_to).toEqual(['**/*']); // default
    expect(pack.rules[0]!.context_lines).toBe(1); // default
  });

  it('rejects malformed packs (exit-2 path)', () => {
    expect(() => parsePack('pack: x\nversion: 1\nrules: []', 'x.yaml')).toThrow(RulesetError); // min 1 rule
    expect(() =>
      parsePack('pack: x\nversion: 1\nrules:\n  - id: bad\n    title: t\n    severity: high\n    kind: regex\n    patterns: [a]', 'x.yaml'),
    ).toThrow(/rule id must look like/);
    expect(() =>
      parsePack('pack: x\nversion: 1\nrules:\n  - id: PI-001\n    title: t\n    severity: nope\n    kind: regex\n    patterns: [a]', 'x.yaml'),
    ).toThrow(RulesetError); // bad severity
    expect(() =>
      parsePack('pack: x\nversion: 1\nrules:\n  - id: PI-001\n    title: t\n    severity: high\n    kind: regex', 'x.yaml'),
    ).toThrow(/regex rule requires/); // missing patterns
    expect(() =>
      parsePack('pack: x\nversion: 1\nrules:\n  - id: PI-001\n    title: t\n    severity: high\n    kind: regex\n    patterns: [a]\n    bogus: 1', 'x.yaml'),
    ).toThrow(RulesetError); // unknown key
  });

  it('rejects invalid YAML with a RulesetError naming the file', () => {
    expect(() => parsePack('rules: [unclosed', 'broken.yaml')).toThrow(/broken\.yaml: YAML parse error/);
  });
});

describe('ruleset_hash', () => {
  it('is invariant under whitespace and key-order reformatting', () => {
    const reordered = `
version: 1
pack: prompt-injection
rules:
  - kind: regex
    severity: high
    title: Instruction override
    id: PI-001
    flags: i
    patterns:
      - "ignore (all )?(previous|prior) instructions"
    examples:
      no_match: ["follow the instructions carefully"]
      match: ["Ignore previous instructions"]
  - id: UNI-001
    title: Zero-width characters
    severity: high
    kind: codepoints
    codepoints: ["U+200B", "U+200C", "U+2060-U+2064"]
`;
    expect(sha256Canonical(parsePack(reordered, 'a.yaml'))).toBe(sha256Canonical(parsePack(VALID, 'b.yaml')));
  });

  it('changes when a rule is semantically edited', () => {
    const edited = VALID.replace('severity: high', 'severity: critical');
    expect(sha256Canonical(parsePack(edited, 'a.yaml'))).not.toBe(sha256Canonical(parsePack(VALID, 'b.yaml')));
  });
});

describe('loadRuleset', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skillcheck-rules-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('loads packs, flattens rules, and computes a stable hash', () => {
    writeFileSync(join(dir, 'prompt-injection.yaml'), VALID);
    const rs = loadRuleset(dir);
    expect(rs.rules).toHaveLength(2);
    expect(rs.rules.every((r) => r.pack === 'prompt-injection')).toBe(true);
    expect(rs.rulesetHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects duplicate rule ids across packs', () => {
    const dupDir = mkdtempSync(join(tmpdir(), 'skillcheck-dup-'));
    writeFileSync(join(dupDir, 'a.yaml'), VALID);
    writeFileSync(
      join(dupDir, 'b.yaml'),
      'pack: other\nversion: 1\nrules:\n  - id: PI-001\n    title: t\n    severity: low\n    kind: regex\n    patterns: [x]',
    );
    expect(() => loadRuleset(dupDir)).toThrow(/Duplicate rule id PI-001/);
    rmSync(dupDir, { recursive: true, force: true });
  });
});

describe('parseCodepointSpec', () => {
  it('parses singles and ranges', () => {
    expect(parseCodepointSpec('U+200B')).toEqual({ start: 0x200b, end: 0x200b });
    expect(parseCodepointSpec('U+202A-U+202E')).toEqual({ start: 0x202a, end: 0x202e });
    expect(parseCodepointSpec('U+E0000-U+E007F')).toEqual({ start: 0xe0000, end: 0xe007f });
  });
});
