import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

// Guards against an editor / formatter / git filter silently stripping the raw invisible
// codepoints out of the unicode fixtures — which would make the UNI goldens quietly pass
// against neutered inputs. If this fails, the fixtures were corrupted; regenerate with
// scripts/build-corpus.ts, do not "fix" by regenerating the goldens blindly.
const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'corpus');

describe('fixture integrity — raw invisibles present', () => {
  it('unicode-hidden carries raw zero-width, bidi, and tag codepoints', () => {
    const s = readFileSync(join(CORPUS, 'unicode-hidden', 'skill', 'SKILL.md'), 'utf8');
    expect(s.includes('​'), 'zero-width space').toBe(true);
    expect(s.includes('‮'), 'RLO bidi override').toBe(true);
    expect(s.includes('\u{E0041}'), 'tag character').toBe(true);
  });

  it('combined-nasty carries raw invisibles alongside injection text', () => {
    const s = readFileSync(join(CORPUS, 'combined-nasty', 'skill', 'SKILL.md'), 'utf8');
    expect(s.includes('​')).toBe(true);
    expect(s.includes('‮')).toBe(true);
    expect(s.toLowerCase()).toContain('ignore all previous instructions');
  });
});
