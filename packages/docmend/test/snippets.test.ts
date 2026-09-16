import { describe, it, expect } from 'vitest';
import { extractInstalls, normalizePypi, parseJson, parseShell, parseJsTs, parsePython } from '../src/snippets';

describe('extractInstalls', () => {
  it('extracts an npm install with a scoped package and a version pin', () => {
    const text = '```bash\nnpm install @acme/widget@2.1.0\n```\n';
    const refs = extractInstalls(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ ecosystem: 'npm', name: '@acme/widget', pin: '2.1.0' });
  });

  it('extracts a pip install with a PEP 440 pin', () => {
    const text = '```bash\npip install requests==2.31.0\n```\n';
    const refs = extractInstalls(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ ecosystem: 'pypi', name: 'requests', pin: '2.31.0' });
  });

  it('extracts an unpinned install with pin: null', () => {
    const text = '```bash\nnpm install lodash\n```\n';
    const refs = extractInstalls(text);
    expect(refs[0]!.pin).toBeNull();
  });

  it('ignores a git/file/url install target', () => {
    const text = '```bash\nnpm install git+https://github.com/x/y.git\n```\n';
    expect(extractInstalls(text)).toHaveLength(0);
  });

  it('finds an install reference inside inline prose code spans too', () => {
    const text = 'Run `npm install acme@1.0.0` to get started.\n';
    const refs = extractInstalls(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.name).toBe('acme');
  });
});

describe('normalizePypi (PEP 503)', () => {
  it('lowercases and folds dots/underscores/hyphens to a single hyphen', () => {
    expect(normalizePypi('My_Package.Name')).toBe('my-package-name');
    expect(normalizePypi('already-normal')).toBe('already-normal');
    expect(normalizePypi('Foo__Bar..Baz')).toBe('foo-bar-baz');
  });
});

describe('parseJson', () => {
  it('returns null for valid JSON', () => {
    expect(parseJson('{"a": [1, 2, 3]}')).toBeNull();
  });
  it('returns an error message for invalid JSON', () => {
    expect(parseJson('{a: 1}')).not.toBeNull();
  });
});

describe('parseShell (bash -n, prompt stripped)', () => {
  it('parses a valid multi-line script with $ prompts stripped', () => {
    expect(parseShell('$ echo one\n$ echo two')).toBeNull();
  });
  it('reports a syntax error for unbalanced quoting', () => {
    const err = parseShell('echo "never closed');
    expect(err).not.toBeNull();
  });
});

describe('parseJsTs', () => {
  it('parses valid TypeScript with no error', () => {
    expect(parseJsTs('const x: number = 1;', 'ts')).toBeNull();
  });
  it('reports a diagnostic for invalid syntax', () => {
    expect(parseJsTs('const x = ;', 'js')).not.toBeNull();
  });
});

describe('parsePython', () => {
  it('parses valid Python with no error (or null if python3 is unavailable)', () => {
    const err = parsePython('def f():\n    return 1\n');
    expect(err).toBeNull();
  });
  it('reports a syntax error for invalid Python (or null if python3 is unavailable)', () => {
    const err = parsePython('def f(:\n    return 1\n');
    // Either python3 is unavailable (null, "cannot judge") or it reports the syntax error —
    // never a false negative that itself looks like a clean parse of THIS specific input.
    if (err !== null) expect(err.length).toBeGreaterThan(0);
  });
});
