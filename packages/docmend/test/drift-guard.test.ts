// docmend copies three OTR modules (see tasks/specs/docmend.md "Reuse") rather than
// importing OTR (private/frozen). This test hashes the copied bodies against the OTR
// originals on disk so any future edit to either side becomes visible immediately instead
// of silently drifting.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256Hex } from '@portfolio-builds/shared';

const DOCMEND_SRC = resolve(__dirname, '..', 'src');
const OTR_SRC = resolve(__dirname, '..', '..', 'onboarding-transfer-rate', 'src');

/** Strip a leading contiguous run of blank lines and `//` comment lines. */
function stripLeadingComment(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === '' || lines[i]!.trim().startsWith('//'))) i++;
  return lines.slice(i).join('\n');
}

function extractFunctionSource(src: string, name: string): string {
  const re = new RegExp(`(export\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found in source`);
  const start = m.index;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) throw new Error(`no body found for ${name}`);
  let depth = 0;
  let end = braceStart;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return src.slice(start, end);
}

describe('drift-guard: markdown.ts is a byte-identical copy of OTR', () => {
  it('hashes equal after stripping the provenance header', () => {
    const docmend = stripLeadingComment(readFileSync(resolve(DOCMEND_SRC, 'markdown.ts'), 'utf8'));
    const otr = stripLeadingComment(readFileSync(resolve(OTR_SRC, 'markdown.ts'), 'utf8'));
    expect(sha256Hex(docmend)).toBe(sha256Hex(otr));
  });
});

describe('drift-guard: textify.ts is a byte-identical copy of OTR', () => {
  it('hashes equal after stripping the provenance header', () => {
    const docmend = stripLeadingComment(readFileSync(resolve(DOCMEND_SRC, 'textify.ts'), 'utf8'));
    const otr = stripLeadingComment(readFileSync(resolve(OTR_SRC, 'textify.ts'), 'utf8'));
    expect(sha256Hex(docmend)).toBe(sha256Hex(otr));
  });
});

describe('drift-guard: snippets.ts copied functions match OTR l1.ts', () => {
  const docmendSrc = readFileSync(resolve(DOCMEND_SRC, 'snippets.ts'), 'utf8');
  const otrSrc = readFileSync(resolve(OTR_SRC, 'l1.ts'), 'utf8');

  const copiedFunctions = ['normalizePypi', 'extractInstalls', 'scanSegment', 'parseJsTs', 'parsePython'];

  for (const name of copiedFunctions) {
    it(`${name} is byte-identical to onboarding-transfer-rate/src/l1.ts`, () => {
      const a = extractFunctionSource(docmendSrc, name);
      const b = extractFunctionSource(otrSrc, name);
      expect(sha256Hex(a)).toBe(sha256Hex(b));
    });
  }

  it('adds parseJson and parseShell, which OTR never had', () => {
    expect(docmendSrc).toMatch(/export function parseJson\(/);
    expect(docmendSrc).toMatch(/export function parseShell\(/);
    expect(otrSrc).not.toMatch(/function parseJson\(/);
    expect(otrSrc).not.toMatch(/function parseShell\(/);
  });
});
