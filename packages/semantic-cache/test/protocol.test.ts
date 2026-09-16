import { describe, it, expect } from 'vitest';
import { loadProtocol, PROTOCOL_DIR } from '../src/protocol';
import { sha256Canonical } from '@portfolio-builds/shared';

describe('protocol', () => {
  it('hash covers both files: changing either file changes the hash', () => {
    const protocol = loadProtocol();
    expect(protocol.hash).toBe(sha256Canonical({ cacheRules: protocol.cacheRules, paraphraseSet: protocol.paraphraseSet }));

    const mutatedRules = { ...protocol.cacheRules, sweep: { ...protocol.cacheRules.sweep, shipped_tau: 0.5 } };
    const hashWithMutatedRules = sha256Canonical({ cacheRules: mutatedRules, paraphraseSet: protocol.paraphraseSet });
    expect(hashWithMutatedRules).not.toBe(protocol.hash);

    const mutatedSet = { ...protocol.paraphraseSet, seed: 1 };
    const hashWithMutatedSet = sha256Canonical({ cacheRules: protocol.cacheRules, paraphraseSet: mutatedSet });
    expect(hashWithMutatedSet).not.toBe(protocol.hash);
  });

  it('loads the frozen 40-intent paraphrase set from PROTOCOL_DIR deterministically', () => {
    const a = loadProtocol(PROTOCOL_DIR);
    const b = loadProtocol(PROTOCOL_DIR);
    expect(a.hash).toBe(b.hash);
    expect(a.paraphraseSet.intents).toHaveLength(40);
  });
});
