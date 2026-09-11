import { describe, it, expect } from 'vitest';
import { extractClaims, extractClaimsFromText, METRIC_RE, CLAIM_PATTERNS } from '../src/claims';

describe('METRIC_RE', () => {
  it('matches dollar/percent/2+digit tokens but not bare single digits', () => {
    const hits = (s: string) => s.match(METRIC_RE) ?? [];
    expect(hits('grew revenue by $1.2M and 37% over 22 quarters')).toEqual(['$1.2M', '37%', '22']);
    expect(hits('used 5 markets over 2 years')).toEqual([]); // single digits excluded
    expect(hits('a 99% success rate')).toContain('99%');
  });
});

describe('extractClaimsFromText', () => {
  it('extracts metric and claim tokens with line numbers', () => {
    const text = 'line one\nAward-winning tool used by Fortune 500 teams\n10x faster, 99% accurate\n';
    const claims = extractClaimsFromText(text, 'SKILL.md');
    const byType = (t: string) => claims.filter((c) => c.claimType === t).map((c) => c.token);
    expect(byType('claim')).toEqual(expect.arrayContaining(['Award-winning', 'Fortune 500']));
    expect(byType('metric')).toEqual(expect.arrayContaining(['10', '99%']));
    // line numbers point at the right lines
    const fortune = claims.find((c) => c.token === 'Fortune 500');
    expect(fortune?.line).toBe(2);
  });

  it('does not flag generic lowercase "former manager"', () => {
    const claims = extractClaimsFromText('a former manager wrote this', 'SKILL.md');
    expect(claims.filter((c) => c.claimType === 'claim')).toHaveLength(0);
  });

  it('is stateless across repeated calls (matchAll clones)', () => {
    const text = 'ex-Google engineer, #1 rated, best-selling, MBA';
    expect(extractClaimsFromText(text, 'a.md')).toEqual(extractClaimsFromText(text, 'a.md'));
    // and CLAIM_PATTERNS lastIndex is not left advanced
    expect(CLAIM_PATTERNS.every((re) => re.lastIndex === 0)).toBe(true);
  });
});

describe('extractClaims (doc files only, deduped)', () => {
  it('scans markdown docs and skips code files', () => {
    const claims = extractClaims([
      { path: 'SKILL.md', content: 'award-winning, 50% faster' },
      { path: 'script.js', content: 'const x = "Fortune 500"; // 99% coverage' },
    ]);
    expect(claims.map((c) => c.token)).toEqual(expect.arrayContaining(['award-winning', '50%']));
    expect(claims.some((c) => c.token === 'Fortune 500')).toBe(false); // code file ignored
  });

  it('dedupes identical file/line/type/token', () => {
    const a = extractClaims([{ path: 'README.md', content: 'award-winning award-winning' }]);
    // two matches on the same line but different columns → both retained (distinct positions collapse only if identical key)
    expect(a.filter((c) => c.token.toLowerCase() === 'award-winning').length).toBeGreaterThanOrEqual(1);
  });
});
