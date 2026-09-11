import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProtocol } from '../src/protocol';
import { textifyHtml, textifyMarkdown } from '../src/textify';
import { fencedBlocks, headings, sectionByHeading, proseLines } from '../src/markdown';
import { findMilestone, findTimeClaim } from '../src/l0';

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (name: string) => readFileSync(resolve(FIX, name), 'utf8');
const protocol = loadProtocol();
const { checks, corpusRule } = protocol;
const QS_RE = new RegExp(corpusRule.quickstart.text_re, corpusRule.quickstart.text_re_flags);

describe('protocol', () => {
  it('loads and hashes both frozen files (hash is stable across key order)', () => {
    expect(protocol.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(loadProtocol().hash).toBe(protocol.hash);
  });
  it('every L1 check has a category and every milestone pattern compiles', () => {
    for (const c of checks.l1) expect(c.category).toBeTruthy();
    for (const p of checks.l0.milestone.patterns) expect(() => new RegExp(p, checks.l0.milestone.flags)).not.toThrow();
  });
});

describe('textify: html', () => {
  const t = textifyHtml(fx('html-docs-page.html'), 'https://docs.nova.example/docs/quickstart');
  it('drops script/style/nav chrome and keeps headings, prose, and fenced code with language', () => {
    expect(t.title).toBe('Quickstart — Nova Docs');
    expect(t.text).not.toContain('window.__nav');
    expect(t.text).not.toContain('color: red');
    expect(t.text).toContain('# Quickstart');
    expect(t.text).toContain('```bash\nnpm install @nova/sdk\n```');
    expect(t.text).toContain('```js\nimport { Nova } from "@nova/sdk";');
    expect(t.text).toContain("If everything works, you'll see `pong` printed.");
  });
  it('resolves relative links, dedupes, and finds the edit-on-GitHub link', () => {
    // "../reference/" resolved against /docs/quickstart (no trailing slash) is /reference/
    expect(t.links).toContain('https://docs.nova.example/reference/');
    expect(t.links).toContain('https://community.nova.example/');
    expect(t.editLink).toBe('https://github.com/nova-org/nova/edit/main/docs/quickstart.md');
  });
  it('is deterministic', () => {
    expect(textifyHtml(fx('html-docs-page.html'), 'https://docs.nova.example/docs/quickstart').text).toBe(t.text);
  });
});

describe('textify: markdown', () => {
  it('passes through, finds the H1 title and absolute links only', () => {
    const t = textifyMarkdown(fx('readme-sections.md'));
    expect(t.title).toBe('Comet');
    // document order; the badge image URL precedes its wrapping link's target; no trailing period
    expect(t.links).toEqual(['https://img.shields.io/badge/build-passing-green.svg', 'https://ci.example/comet', 'https://example.com/contributing']);
  });
});

describe('markdown helpers', () => {
  const text = fx('readme-sections.md');
  it('finds fenced blocks with language and 1-based lines', () => {
    const b = fencedBlocks(text);
    expect(b.map((x) => x.lang)).toEqual(['bash', 'js', '']);
    expect(b[0]!.code).toBe('npm i comet-core@2.0.0');
    expect(text.split('\n')[b[0]!.startLine - 1]).toBe('```bash');
  });
  it('lists ATX headings outside fences', () => {
    expect(headings(text).map((h) => `${h.level}:${h.text}`)).toEqual(['1:Comet', '2:Features', '2:Getting Started', '3:Advanced', '2:Contributing']);
  });
  it('extracts the quickstart section up to the next same-level heading', () => {
    const s = sectionByHeading(text, QS_RE)!;
    expect(s.heading.text).toBe('Getting Started');
    expect(s.text.startsWith('## Getting Started')).toBe(true);
    expect(s.text).toContain('### Advanced');
    expect(s.text).not.toContain('## Contributing');
  });
  it('prose lines exclude fenced code', () => {
    const p = proseLines(text).map((x) => x.text);
    expect(p).not.toContain('comet();');
    expect(p).toContain('Expected output:');
  });
});

describe('L0 milestone extraction (frozen patterns)', () => {
  it('md-with-milestone: "You should see:" with its expected-output block', () => {
    const t = textifyMarkdown(fx('md-with-milestone.md')).text;
    const m = findMilestone(t, checks)!;
    expect(m).not.toBeNull();
    expect(m.text).toBe('You should see:');
    expect(m.expectedOutput).toBe('Hello from Acme!');
    expect(t.split('\n')[m.line - 1]).toBe(m.text);
  });
  it('md-no-milestone: none', () => {
    expect(findMilestone(textifyMarkdown(fx('md-no-milestone.md')).text, checks)).toBeNull();
  });
  it('html-docs-page: "If everything works" with no code block after it', () => {
    const t = textifyHtml(fx('html-docs-page.html'), 'https://docs.nova.example/docs/quickstart').text;
    const m = findMilestone(t, checks)!;
    expect(m.text).toContain('If everything works');
    expect(m.expectedOutput).toBeNull();
  });
  it('md-congrats: congratulations line', () => {
    const m = findMilestone(textifyMarkdown(fx('md-congrats.md')).text, checks)!;
    expect(m.text).toBe("Congratulations! You've built your first Orbit agent.");
  });
  it('md-output-heading: an "Output" heading counts, with its block', () => {
    const m = findMilestone(textifyMarkdown(fx('md-output-heading.md')).text, checks)!;
    expect(m.text).toBe('### Output');
    expect(m.expectedOutput).toBe('{"status": "ok"}');
  });
  it('readme-sections: milestone is found inside the extracted section with section-relative line', () => {
    const s = sectionByHeading(fx('readme-sections.md'), QS_RE)!;
    const m = findMilestone(s.text, checks)!;
    expect(m.text).toBe('Expected output:');
    expect(s.text.split('\n')[m.line - 1]).toBe('Expected output:');
  });
});

describe('L0 time claim', () => {
  it('finds "5 minutes" in the lead, "two minutes" in html prose, "Ten minute" in an H1, none in md-congrats', () => {
    const a = findTimeClaim(textifyMarkdown(fx('md-with-milestone.md')).text, 'Acme Agent SDK', checks)!;
    expect([a.value, a.unit, a.where]).toEqual(['5', 'minutes', 'lead']);
    const html = textifyHtml(fx('html-docs-page.html'), 'https://docs.nova.example/');
    const b = findTimeClaim(html.text, html.title, checks)!;
    expect([b.value.toLowerCase(), b.unit]).toEqual(['two', 'minutes']);
    const c = findTimeClaim(textifyMarkdown(fx('md-output-heading.md')).text, null, checks)!;
    expect([c.value, c.unit, c.where]).toEqual(['Ten', 'minute', 'h1']);
    expect(findTimeClaim(textifyMarkdown(fx('md-congrats.md')).text, null, checks)).toBeNull();
  });
});
