import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtocol, PKG_ROOT, FIXTURES_DIR } from '../src/protocol';
import { redactionAudit, auditTree, protocolFrozen } from '../src/audit';

const protocol = loadProtocol();
const LABELED = resolve(FIXTURES_DIR, 'labeled');

describe('redactionAudit', () => {
  it('passes a clean committed labeled fixture', () => {
    const f = readdirSync(LABELED).filter((x) => x.endsWith('.json'))[0]!;
    const rec = JSON.parse(readFileSync(resolve(LABELED, f), 'utf8'));
    expect(redactionAudit(rec, protocol)).toEqual([]);
  });

  it('flags a forbidden content-sink key', () => {
    const v = redactionAudit({ content: 'secret free text' }, protocol);
    expect(v.some((x) => x.kind === 'forbidden-key' && x.detail === 'content')).toBe(true);
  });

  it('flags stdout and cwd keys', () => {
    expect(redactionAudit({ stdout: 'x' }, protocol).some((x) => x.detail === 'stdout')).toBe(true);
    expect(redactionAudit({ cwd: 'anything' }, protocol).some((x) => x.detail === 'cwd')).toBe(true);
  });

  it('flags an absolute-path shape', () => {
    const v = redactionAudit({ note: '/etc/passwd/shadow' }, protocol);
    expect(v.some((x) => x.kind === 'path-shape')).toBe(true);
    expect(redactionAudit({ note: '/Users/alice/thing' }, protocol).some((x) => x.kind === 'path-shape')).toBe(true);
  });

  it('flags a string over 64 chars', () => {
    const v = redactionAudit({ blob: 'a'.repeat(65) }, protocol);
    expect(v.some((x) => x.kind === 'long-string')).toBe(true);
  });

  it('flags a raw (non-token) id', () => {
    const v = redactionAudit({ runId: 'session-1234-plaintext' }, protocol);
    expect(v.some((x) => x.kind === 'bad-id')).toBe(true);
  });
});

describe('auditTree', () => {
  it('finds zero violations across the 40 committed labeled fixtures', () => {
    const res = auditTree([LABELED], protocol, PKG_ROOT);
    expect(res.filesScanned).toBe(40);
    expect(res.violations).toEqual([]);
  });
});

describe('protocolFrozen', () => {
  it('passes trivially before any ingest', () => {
    expect(protocolFrozen(protocol, null).ok).toBe(true);
    expect(protocolFrozen(protocol, { protocolHash: protocol.hash, protocolCommit: null, ingestedAt: null }).ok).toBe(true);
  });

  it('passes when the recorded hash matches and the commit precedes ingest', () => {
    const r = protocolFrozen(protocol, { protocolHash: protocol.hash, protocolCommit: 'abc123', ingestedAt: '2026-09-15T00:00:00Z' }, { commitPrecedesIngest: true });
    expect(r.ok).toBe(true);
  });

  it('fails when the protocol changed after data was collected', () => {
    const r = protocolFrozen(protocol, { protocolHash: 'deadbeef', protocolCommit: 'abc', ingestedAt: '2026-09-15T00:00:00Z' }, { commitPrecedesIngest: true });
    expect(r.ok).toBe(false);
  });

  it('fails when the protocol commit does not precede ingest', () => {
    const r = protocolFrozen(protocol, { protocolHash: protocol.hash, protocolCommit: 'abc', ingestedAt: '2026-09-15T00:00:00Z' }, { commitPrecedesIngest: false });
    expect(r.ok).toBe(false);
  });
});
