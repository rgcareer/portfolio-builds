import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProtocol } from '../src/protocol';
import { textifyMarkdown, textifyHtml } from '../src/textify';
import { findMilestone } from '../src/l0';
import { extractInstalls, normalizePypi, parseJsTs, parsePython, runL1 } from '../src/l1';
import { fakeLookup } from '../src/registries';

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (name: string) => readFileSync(resolve(FIX, name), 'utf8');
const { checks } = loadProtocol();

describe('install extraction', () => {
  it('finds npm and pip installs with pins, flags, scopes, multiple packages, and skips files/urls', () => {
    const text = [
      '```bash',
      '$ npm install -g @nova/sdk@1.2.3 lodash',
      'pip install acme-agent==1.2.0 requests[security]>=2.0 -r requirements.txt',
      'uv add orbit-agents',
      'pip install git+https://github.com/x/y.git',
      'npm i ./local-dir',
      '```',
      'Run `pip install foo` first, then read the docs.',
    ].join('\n');
    const refs = extractInstalls(text).map((r) => `${r.ecosystem}:${r.name}${r.pin ? '@' + r.pin : ''}#${r.line}`);
    expect(refs).toEqual(['npm:@nova/sdk@1.2.3#2', 'npm:lodash#2', 'pypi:acme-agent@1.2.0#3', 'pypi:requests#3', 'pypi:orbit-agents#4', 'pypi:foo#8']);
  });
  it('normalizes PyPI names per PEP 503', () => {
    expect(normalizePypi('Acme_Agent.SDK')).toBe('acme-agent-sdk');
  });
});

describe('syntax parsers (parse only, never execute)', () => {
  it('accepts valid js/ts and rejects broken js', () => {
    expect(parseJsTs('import { x } from "y";\nconst a = await x();', 'js')).toBeNull();
    expect(parseJsTs('const a: number = 1;', 'ts')).toBeNull();
    expect(parseJsTs('const a = ;', 'js')).toMatch(/^TS\d+/);
  });
  it('accepts valid python and rejects broken python', () => {
    expect(parsePython('import os\nprint(os.getcwd())')).toBeNull();
    expect(parsePython('def f(:\n  pass')).toMatch(/SyntaxError|invalid/i);
  });
});

describe('runL1 on fixtures with a fake lookup', () => {
  it('md-with-milestone: passes when registry + links are fine; env var and pip introduced in prose; auth-wall stratum', async () => {
    const t = textifyMarkdown(fx('md-with-milestone.md'));
    const m = findMilestone(t.text, checks)!;
    const lookup = fakeLookup({ pypi: { 'acme-agent': { exists: true, latest: '1.4.0', deprecated: false } } });
    const r = await runL1({ text: t.text, links: t.links, selfUrl: null, milestoneLine: m.line }, checks, lookup);
    // ACME_API_KEY: "Set your key first" does not name it -> missing-prerequisite; pip never in prose -> missing-prerequisite
    const cats = r.findings.map((f) => `${f.category}${f.counted ? '' : '(uncounted)'}`);
    expect(cats).toContain('missing-prerequisite');
    expect(r.findings.find((f) => f.detail.includes('ACME_API_KEY'))).toBeTruthy();
    expect(r.findings.find((f) => f.detail.includes('"pip"'))).toBeTruthy();
    expect(r.needsCredential).toBe(false); // "key" alone is not in the frozen auth pattern
    expect(lookup.calls).toContain('pypi:acme-agent');
    expect(lookup.calls).toContain('link:https://docs.acme.example/guide');
    expect(r.passed).toBe(false);
  });

  it('version drift: a pin one major behind is flagged; same major is not', async () => {
    const text = '## Getting started\n\nInstall with npm:\n\n```bash\nnpm i comet-core@2.0.0\n```\n';
    const a = await runL1({ text, links: [], selfUrl: null, milestoneLine: null }, checks, fakeLookup({ npm: { 'comet-core': { exists: true, latest: '3.1.0', deprecated: false } } }));
    expect(a.findings.map((f) => f.category)).toEqual(['version-drift']);
    const b = await runL1({ text, links: [], selfUrl: null, milestoneLine: null }, checks, fakeLookup({ npm: { 'comet-core': { exists: true, latest: '2.9.0', deprecated: false } } }));
    expect(b.findings).toEqual([]);
    expect(b.passed).toBe(true);
  });

  it('missing package and deprecated package are broken-command / version-drift with line citations', async () => {
    const text = 'Use pip to install:\n\n```bash\npip install no-such-pkg-xyz\npip install oldpkg\n```\n';
    const r = await runL1({ text, links: [], selfUrl: null, milestoneLine: null }, checks, fakeLookup({ pypi: { oldpkg: { exists: true, latest: '1.0', deprecated: true } } }));
    expect(r.findings.map((f) => [f.category, f.line])).toEqual([
      ['broken-command', 4],
      ['version-drift', 5],
    ]);
    for (const f of r.findings) expect(text.split('\n')[f.line - 1]).toBe(f.excerpt);
  });

  it('broken links are flagged; images, badges, self, and localhost are skipped; cap 25', async () => {
    const links = ['https://a.example/ok', 'https://a.example/gone', 'https://img.shields.io/x.svg', 'https://a.example/pic.png', 'http://localhost:8080/', 'https://self.example/page'];
    for (let i = 0; i < 40; i++) links.push(`https://a.example/many/${i}`);
    const lookup = fakeLookup({ links: { 'https://a.example/gone': { status: 404, ok: false, error: null } } });
    const r = await runL1({ text: 'see https://a.example/gone\n', links, selfUrl: 'https://self.example/page#x', milestoneLine: null }, checks, lookup);
    expect(r.findings.map((f) => [f.category, f.line, f.detail])).toEqual([['broken-link', 1, 'GET https://a.example/gone -> 404']]);
    expect(lookup.calls.filter((c) => c.startsWith('link:')).length).toBe(25);
    expect(lookup.calls).not.toContain('link:http://localhost:8080/');
    expect(lookup.calls).not.toContain('link:https://self.example/page');
    expect(lookup.calls).not.toContain('link:https://a.example/pic.png');
  });

  it('prereq order: tools and env vars mentioned in prose are fine; a docker-only block with no prose mention is flagged', async () => {
    const ok = 'You need Docker and Python installed. Set MY_TOKEN in your shell.\n\n```bash\ndocker run x\npython3 app.py\nexport MY_TOKEN=abc\n```\n';
    const a = await runL1({ text: ok, links: [], selfUrl: null, milestoneLine: null }, checks, fakeLookup({}));
    expect(a.findings.filter((f) => f.category === 'missing-prerequisite')).toEqual([]);
    const bad = 'Run it:\n\n```sh\ndocker compose up\n```\n';
    const b = await runL1({ text: bad, links: [], selfUrl: null, milestoneLine: null }, checks, fakeLookup({}));
    expect(b.findings.map((f) => f.detail)).toEqual(['command-line tool "docker" is used but never mentioned in prose']);
  });

  it('code parse: a broken js block is flagged at its fence line; fragments with ... and REPL transcripts are skipped', async () => {
    const text = '```js\nconst a = ;\n```\n\n```python\n>>> import x\n```\n\n```ts\nfunction f() { ... }\n```\n';
    const r = await runL1({ text, links: [], selfUrl: null, milestoneLine: null }, checks, fakeLookup({}));
    expect(r.findings.map((f) => [f.category, f.line])).toEqual([['broken-command', 1]]);
  });

  it('auth wall: detected only before the milestone and never counted', async () => {
    const t = textifyHtml(fx('html-docs-page.html'), 'https://docs.nova.example/docs/quickstart');
    const m = findMilestone(t.text, checks)!;
    const lookup = fakeLookup({ npm: { '@nova/sdk': { exists: true, latest: '1.0.0', deprecated: false } } });
    const r = await runL1({ text: t.text, links: t.links, selfUrl: 'https://docs.nova.example/docs/quickstart', milestoneLine: m.line }, checks, lookup);
    // the code line "apiKey: process.env.NOVA_API_KEY" matches the frozen api[ _-]?key phrase before the milestone
    expect(r.needsCredential).toBe(true);
    const aw0 = r.findings.find((f) => f.category === 'auth-wall')!;
    expect(aw0.counted).toBe(false);
    expect(t.text.split('\n')[aw0.line - 1]).toContain('apiKey');
    const withKey = 'Get an API key from the console.\n\n```bash\nnpm i x\n```\nYou should see hi.\n';
    const k = await runL1({ text: withKey, links: [], selfUrl: null, milestoneLine: 6 }, checks, fakeLookup({ npm: { x: { exists: true, latest: '1', deprecated: false } } }));
    expect(k.needsCredential).toBe(true);
    const aw = k.findings.find((f) => f.category === 'auth-wall')!;
    expect(aw.counted).toBe(false);
    expect(aw.line).toBe(1);
  });
});
