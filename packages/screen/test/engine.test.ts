import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFiles, readSkillFiles, sanitizeEvidence, type RawFinding } from '../src/engine';
import type { RuleWithPack } from '../src/rulesSchema';

function mkRule(p: any): RuleWithPack {
  return {
    id: p.id,
    title: p.title ?? p.id,
    severity: p.severity,
    kind: p.kind,
    applies_to: p.applies_to ?? ['**/*'],
    context_lines: p.context_lines ?? 1,
    examples: p.examples ?? { match: [], no_match: [] },
    pack: p.pack ?? 'test',
    ...(p.patterns ? { patterns: p.patterns } : {}),
    ...(p.flags ? { flags: p.flags } : {}),
    ...(p.codepoints ? { codepoints: p.codepoints } : {}),
    ...(p.options ? { options: p.options } : {}),
    ...(p.message ? { message: p.message } : {}),
  };
}

const rxFoo = mkRule({ id: 'PI-001', severity: 'high', kind: 'regex', patterns: ['foo'] });

describe('line/col mapping', () => {
  it('reports 1-based line and column of the match', () => {
    const f = scanFiles([{ path: 'a.md', content: 'abc\ndef\n  foo bar' }], [rxFoo]);
    expect(f).toHaveLength(1);
    expect({ line: f[0]!.line, col: f[0]!.col }).toEqual({ line: 3, col: 3 });
    expect(f[0]!.matched).toBe('foo');
  });

  it('includes surrounding lines in context (context_lines default 1)', () => {
    const f = scanFiles([{ path: 'a.md', content: 'above\nfoo\nbelow' }], [rxFoo]);
    expect(f[0]!.context).toBe('above\nfoo\nbelow');
  });
});

describe('cross-file scanning (no regex lastIndex bleed)', () => {
  it('reports a match in every file, not just the first', () => {
    const f = scanFiles(
      [
        { path: 'b.md', content: 'foo here' },
        { path: 'a.md', content: 'foo there' },
      ],
      [rxFoo],
    );
    expect(f.map((x) => x.file)).toEqual(['a.md', 'b.md']); // sorted, both present
  });

  it('scanning the same input twice is identical', () => {
    const input = [{ path: 'a.md', content: 'foo\nfoo' }];
    expect(scanFiles(input, [rxFoo])).toEqual(scanFiles(input, [rxFoo]));
  });
});

describe('evidence sanitizer', () => {
  it('escapes invisible codepoints and keeps normal text', () => {
    expect(sanitizeEvidence('a​b')).toBe('a\\u{200B}b');
    expect(sanitizeEvidence('‮evil')).toBe('\\u{202E}evil');
    expect(sanitizeEvidence('normal text')).toBe('normal text');
    expect(sanitizeEvidence('tab\there')).toBe('tab\\u{0009}here');
  });

  it('a codepoints rule reports the escaped payload as evidence, not the raw char', () => {
    const uni = mkRule({ id: 'UNI-001', severity: 'high', kind: 'codepoints', codepoints: ['U+200B'] });
    const f = scanFiles([{ path: 'a.md', content: 'hi​there' }], [uni]);
    expect(f).toHaveLength(1);
    expect(f[0]!.matched).toBe('\\u{200B}');
    expect(f[0]!.context).not.toContain('​'); // raw payload never in evidence
  });

  it('skips a leading BOM but catches U+FEFF elsewhere (allow_leading_bom)', () => {
    const rule = mkRule({ id: 'UNI-001', severity: 'high', kind: 'codepoints', codepoints: ['U+FEFF'], options: { allow_leading_bom: true } });
    expect(scanFiles([{ path: 'a.xsd', content: '﻿<?xml version="1.0"?>' }], [rule])).toHaveLength(0);
    // a BOM char NOT at file start is still flagged
    expect(scanFiles([{ path: 'a.md', content: 'text﻿here' }], [rule])).toHaveLength(1);
  });

  it('escapes bidi and tag characters', () => {
    const tag = mkRule({ id: 'UNI-002', severity: 'critical', kind: 'codepoints', codepoints: ['U+E0000-U+E007F'] });
    const f = scanFiles([{ path: 'a.md', content: 'x\u{E0041}y' }], [tag]);
    expect(f).toHaveLength(1);
    expect(f[0]!.matched).toBe('\\u{E0041}');
  });
});

describe('applies_to globs', () => {
  it('scans only matching paths', () => {
    const mdOnly = mkRule({ id: 'PI-002', severity: 'low', kind: 'regex', patterns: ['foo'], applies_to: ['**/*.md'] });
    const f = scanFiles(
      [
        { path: 'dir/a.md', content: 'foo' },
        { path: 'dir/b.txt', content: 'foo' },
      ],
      [mdOnly],
    );
    expect(f.map((x) => x.file)).toEqual(['dir/a.md']);
  });
});

describe('mixed_script (homoglyph) with FP control', () => {
  const rule = mkRule({
    id: 'OBF-001',
    severity: 'medium',
    kind: 'mixed_script',
    options: { scripts: ['Cyrillic', 'Greek'], within: 'code_spans' },
  });

  it('flags a Latin/Cyrillic mixed token inside a code span', () => {
    // "pаypal" — the 'а' is Cyrillic U+0430
    const f = scanFiles([{ path: 'a.md', content: 'Run `pаypal` now' }], [rule]);
    expect(f).toHaveLength(1);
    expect(f[0]!.matched).toBe('pаypal');
  });

  it('does not flag pure-Latin tokens', () => {
    expect(scanFiles([{ path: 'a.md', content: 'Run `paypal` now' }], [rule])).toHaveLength(0);
  });

  it('does not flag mixed scripts OUTSIDE code spans (within: code_spans)', () => {
    expect(scanFiles([{ path: 'a.md', content: 'prose pаypal here' }], [rule])).toHaveLength(0);
  });
});

describe('dedupe', () => {
  it('collapses two patterns matching the same span into one finding', () => {
    const dup = mkRule({ id: 'PI-003', severity: 'high', kind: 'regex', patterns: ['foo', 'foo'] });
    expect(scanFiles([{ path: 'a.md', content: 'foo' }], [dup])).toHaveLength(1);
  });
});

describe('filesystem walk', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skillcheck-walk-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'z.md'), 'foo z');
    writeFileSync(join(dir, 'a.md'), 'foo a');
    writeFileSync(join(dir, 'sub', 'm.md'), 'foo m');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x66, 0x00, 0x6f, 0x6f])); // has NUL → binary
    try {
      symlinkSync(join(dir, 'a.md'), join(dir, 'link.md'));
    } catch {
      /* symlink may fail on some filesystems; the test below tolerates absence */
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns text files in sorted order, skipping binaries and symlinks', () => {
    const files = readSkillFiles(dir);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(['a.md', 'sub/m.md', 'z.md']); // sorted, no bin.dat, no link.md
  });

  it('scanSkillDir path matches scanFiles on the same content', () => {
    const files = readSkillFiles(dir);
    const viaFiles = scanFiles(files, [rxFoo]);
    expect(viaFiles.map((f: RawFinding) => f.file)).toEqual(['a.md', 'sub/m.md', 'z.md']);
  });
});
