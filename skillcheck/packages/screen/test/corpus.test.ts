import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { stableStringify } from '@skillcheck/core';
import { loadRuleset } from '../src/rulesSchema';
import { scanFiles, readSkillFiles } from '../src/engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = resolve(HERE, '..', 'rules');
const CORPUS = resolve(HERE, '..', 'fixtures', 'corpus');
const ruleset = loadRuleset(RULES);

const cases = readdirSync(CORPUS).filter((n) => statSync(join(CORPUS, n)).isDirectory());

describe('fixture-corpus goldens', () => {
  it('has a non-trivial corpus', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of cases) {
    it(`${name} — engine output matches golden byte-for-byte`, () => {
      const skillDir = join(CORPUS, name, 'skill');
      const expected = readFileSync(join(CORPUS, name, 'expected-findings.json'), 'utf8');
      const actual = stableStringify(scanFiles(readSkillFiles(skillDir), ruleset.rules));
      expect(actual).toBe(expected);
    });
  }

  it('ruleset hash is stable across reloads', () => {
    expect(loadRuleset(RULES).rulesetHash).toBe(ruleset.rulesetHash);
  });
});
