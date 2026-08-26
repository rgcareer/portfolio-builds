import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRuleset } from '../src/rulesSchema';
import { scanFiles } from '../src/engine';

// Each rule's examples.match / examples.no_match are executable documentation — they run
// as micro-tests here so the false-positive posture of every rule is verifiable.
const RULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const ruleset = loadRuleset(RULES_DIR);

describe('rule-pack examples', () => {
  it('loads all five packs', () => {
    expect(ruleset.packs.map((p) => p.pack).sort()).toEqual([
      'dangerous-command',
      'data-exfiltration',
      'obfuscation',
      'prompt-injection',
      'unicode',
    ]);
  });

  for (const rule of ruleset.rules) {
    it(`${rule.id} — ${rule.title}`, () => {
      for (const ex of rule.examples.match) {
        const findings = scanFiles([{ path: 'example.md', content: ex }], [rule]);
        expect(findings.length, `${rule.id} SHOULD match ${JSON.stringify(ex)}`).toBeGreaterThan(0);
      }
      for (const ex of rule.examples.no_match) {
        const findings = scanFiles([{ path: 'example.md', content: ex }], [rule]);
        expect(findings.length, `${rule.id} should NOT match ${JSON.stringify(ex)}`).toBe(0);
      }
    });
  }
});
