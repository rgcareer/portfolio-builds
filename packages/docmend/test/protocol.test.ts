import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256Canonical } from '@portfolio-builds/shared';
import { loadProtocol, checkById, fixPolicyFor } from '../src/protocol';

const REAL_PROTOCOL_DIR = resolve(__dirname, '..', 'protocol');
const TMP_DIR = resolve(__dirname, 'fixtures', 'protocol-tmp');

describe('loadProtocol', () => {
  it('loads the real committed protocol and computes a stable hash', () => {
    const a = loadProtocol(REAL_PROTOCOL_DIR);
    const b = loadProtocol(REAL_PROTOCOL_DIR);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toHaveLength(64);
    expect(a.corpusRule.own_repos).toHaveLength(4);
    expect(a.checks.checks.map((c) => c.id)).toContain('D-link');
  });

  it('checkById finds a known check and throws on an unknown one', () => {
    const { checks } = loadProtocol(REAL_PROTOCOL_DIR);
    expect(checkById(checks, 'D-pin').category).toBe('version-drift');
    expect(() => checkById(checks, 'D-does-not-exist')).toThrow(/unknown check/);
  });

  it('fixPolicyFor finds a known category policy and throws on an unknown one', () => {
    const { checks } = loadProtocol(REAL_PROTOCOL_DIR);
    expect(fixPolicyFor(checks, 'stale-pin').proposal).toBe('pin-bump');
    expect(() => fixPolicyFor(checks, 'not-a-category')).toThrow(/no fix_policy/);
  });
});

describe('protocol hash sensitivity', () => {
  it('changing a single byte in checks.json changes the protocol hash', () => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
    const corpusRaw = readFileSync(resolve(REAL_PROTOCOL_DIR, 'corpus-rule.json'), 'utf8');
    const checksRaw = readFileSync(resolve(REAL_PROTOCOL_DIR, 'checks.json'), 'utf8');
    writeFileSync(resolve(TMP_DIR, 'corpus-rule.json'), corpusRaw);
    writeFileSync(resolve(TMP_DIR, 'checks.json'), checksRaw);

    const before = loadProtocol(TMP_DIR);
    expect(before.hash).toBe(sha256Canonical({ corpusRule: JSON.parse(corpusRaw), checks: JSON.parse(checksRaw) }));

    const mutated = JSON.parse(checksRaw);
    mutated.frozen_on = '2099-01-01'; // any single-field change
    writeFileSync(resolve(TMP_DIR, 'checks.json'), JSON.stringify(mutated));
    const after = loadProtocol(TMP_DIR);

    expect(after.hash).not.toBe(before.hash);
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('re-ordering JSON keys does NOT change the hash (canonical serialization)', () => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
    const corpusRaw = readFileSync(resolve(REAL_PROTOCOL_DIR, 'corpus-rule.json'), 'utf8');
    const checksObj = JSON.parse(readFileSync(resolve(REAL_PROTOCOL_DIR, 'checks.json'), 'utf8'));
    writeFileSync(resolve(TMP_DIR, 'corpus-rule.json'), corpusRaw);
    writeFileSync(resolve(TMP_DIR, 'checks.json'), JSON.stringify(checksObj));
    const a = loadProtocol(TMP_DIR);

    // Rebuild the same object with keys inserted in reverse order — same content, different key order.
    const reversed: Record<string, unknown> = {};
    for (const k of Object.keys(checksObj).reverse()) reversed[k] = checksObj[k];
    writeFileSync(resolve(TMP_DIR, 'checks.json'), JSON.stringify(reversed));
    const b = loadProtocol(TMP_DIR);

    expect(a.hash).toBe(b.hash);
    rmSync(TMP_DIR, { recursive: true, force: true });
  });
});
