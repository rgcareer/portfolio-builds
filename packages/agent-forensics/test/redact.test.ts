import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify, findPii, isTokenShaped } from '@portfolio-builds/shared';
import { loadProtocol } from '../src/protocol';
import { keepScalar, errorClassOf, toolNameOf, makeTokenizers } from '../src/redact';
import { parseTranscript } from '../src/adapters/claudeCode';
import { redactionAudit } from '../src/audit';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANARY = resolve(HERE, 'fixtures/transcripts/canary.jsonl');
const SALT = 'test-salt-fixed-0123456789';
const SALT2 = 'other-salt-fixed-9876543210';
const protocol = loadProtocol();

// The exact secrets planted in canary.jsonl.
const CANARIES = [
  'alice@example.com',
  '415-555-0199',
  '/Users/alice/secret',
  'sk-ant-FAKEKEY0123456789abcdefABCDEF',
  '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  'ghp_FAKE0123456789abcdefABCDEFghijklmno',
  'xyzzy plugh forty two',
  'feature/canary',
  'ffffffff-9dad-41d1-89b4-00c04fd430c8',
];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?$/;
const OTHER_TOOL_RE = /^other:[0-9a-f]{8}$/;
const SAFE_ENUM_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;

function stringValues(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, acc);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringValues(v, acc);
  return acc;
}

describe('redaction canary (MANDATORY)', () => {
  const lines = readFileSync(CANARY, 'utf8').split('\n');
  const record = parseTranscript(lines, { salt: SALT, protocol });
  const serialized = stableStringify(record);

  it('leaks none of the planted secrets into the serialized record', () => {
    for (const secret of CANARIES) {
      expect(serialized, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('findPii over the serialized record is empty', () => {
    expect(findPii(serialized)).toEqual([]);
  });

  it('every string value is an allowlisted enum, an ISO timestamp, or an hmac-shaped token', () => {
    const bad = stringValues(record).filter(
      (s) => !(ISO_RE.test(s) || isTokenShaped(s) || OTHER_TOOL_RE.test(s) || SAFE_ENUM_RE.test(s)),
    );
    expect(bad).toEqual([]);
  });

  it('redactionAudit reports zero violations for the record', () => {
    expect(redactionAudit(record, protocol)).toEqual([]);
  });

  it('keeps only allowlisted toolUseResult scalars (durationMs kept, stdout/command dropped)', () => {
    const call = record.toolCalls.find((c) => c.durationMs !== null);
    expect(call?.durationMs).toBe(42);
    expect(serialized).not.toContain('stdout');
    expect(serialized).not.toContain('command');
  });
});

describe('salt behaviour', () => {
  it('refuses to parse without a >=16 char salt', () => {
    expect(() => parseTranscript(['{}'], { salt: '', protocol })).toThrow(/salt/);
    expect(() => parseTranscript(['{}'], { salt: 'too-short', protocol })).toThrow(/salt/);
  });

  it('same salt yields identical tokens; a different salt yields different tokens', () => {
    const lines = readFileSync(CANARY, 'utf8').split('\n');
    const a = parseTranscript(lines, { salt: SALT, protocol });
    const b = parseTranscript(lines, { salt: SALT, protocol });
    const c = parseTranscript(lines, { salt: SALT2, protocol });
    expect(a.runId).toBe(b.runId);
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(a.runId).not.toBe(c.runId);
    expect(a.toolCalls[0]!.inputHash).not.toBe(c.toolCalls[0]!.inputHash);
  });
});

describe('redact primitives', () => {
  it('keepScalar keeps allowlisted scalars and drops everything else', () => {
    expect(keepScalar('durationMs', 42, protocol)).toBe(42);
    expect(keepScalar('interrupted', true, protocol)).toBe(true);
    expect(keepScalar('status', 'ok_done', protocol)).toBe('ok_done');
    expect(keepScalar('status', 'has spaces', protocol)).toBeUndefined();
    expect(keepScalar('stdout', 'secret output', protocol)).toBeUndefined();
    expect(keepScalar('command', 'rm -rf', protocol)).toBeUndefined();
    expect(keepScalar('durationMs', 'not-a-number', protocol)).toBeUndefined();
  });

  it('errorClassOf maps raw text to one frozen label, else other', () => {
    expect(errorClassOf('bash: command timed out after 2m', protocol)).toBe('timeout');
    expect(errorClassOf('Permission denied', protocol)).toBe('permission');
    expect(errorClassOf('No such file or directory', protocol)).toBe('not-found');
    expect(errorClassOf('grep: no matches found', protocol)).toBe('no-matches');
    expect(errorClassOf('exit code 1', protocol)).toBe('exit-nonzero');
    expect(errorClassOf('something weird happened', protocol)).toBe('other');
  });

  it('toolNameOf passes first-party names through and hashes everything else', () => {
    const t = makeTokenizers(SALT);
    expect(toolNameOf('Bash', protocol, t)).toBe('Bash');
    expect(toolNameOf('Read', protocol, t)).toBe('Read');
    const mcp = toolNameOf('mcp__playwright__browser_click', protocol, t);
    expect(mcp).toMatch(OTHER_TOOL_RE);
    // stable + salt-scoped
    expect(toolNameOf('mcp__playwright__browser_click', protocol, t)).toBe(mcp);
    expect(toolNameOf('mcp__playwright__browser_click', protocol, makeTokenizers(SALT2))).not.toBe(mcp);
  });
});
