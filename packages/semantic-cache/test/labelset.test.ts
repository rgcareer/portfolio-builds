import { describe, it, expect } from 'vitest';
import { expandParaphraseSet } from '../src/labelset';
import { loadProtocol } from '../src/protocol';
import { assertNoPii } from '@portfolio-builds/shared';

const protocol = loadProtocol();

describe('expandParaphraseSet', () => {
  it('is deterministic: two expansions of the same protocol produce identical output', () => {
    const a = expandParaphraseSet(protocol.paraphraseSet);
    const b = expandParaphraseSet(protocol.paraphraseSet);
    expect(a).toEqual(b);
  });

  it('gives every intent >= 3 paraphrases and >= 3 negatives', () => {
    const items = expandParaphraseSet(protocol.paraphraseSet);
    for (const intent of protocol.paraphraseSet.intents) {
      const paras = items.filter((i) => i.intentId === intent.id && i.role === 'paraphrase');
      const negs = items.filter((i) => i.intentId === intent.id && i.role === 'negative');
      expect(paras.length).toBeGreaterThanOrEqual(3);
      expect(negs.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('has no duplicate text across the whole expanded set', () => {
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const texts = items.map((i) => i.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('each negative differs from its base in exactly the dimension its kind names', () => {
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const byIntent = new Map<string, typeof items>();
    for (const item of items) {
      const list = byIntent.get(item.intentId) ?? [];
      list.push(item);
      byIntent.set(item.intentId, list);
    }
    for (const intent of protocol.paraphraseSet.intents) {
      const group = byIntent.get(intent.id)!;
      const base = group.find((i) => i.role === 'base')!;
      const slotSwap = group.find((i) => i.role === 'negative' && i.kind === 'slot-swap')!;
      const polarity = group.find((i) => i.role === 'negative' && i.kind === 'polarity')!;
      const entity = group.find((i) => i.role === 'negative' && i.kind === 'entity')!;

      // slot-swap: same template shape, different resolved slot value.
      expect(slotSwap.slotValue).not.toBe(base.slotValue);
      expect(slotSwap.text).not.toBe(base.text);
      expect(slotSwap.text.replace(slotSwap.slotValue, '{id}')).toBe(base.text.replace(base.slotValue, '{id}'));

      // polarity: same slot value, text differs only by the inserted negation.
      expect(polarity.slotValue).toBe(base.slotValue);
      expect(polarity.text).toContain('do not');
      expect(base.text).not.toContain('do not');

      // entity: same slot value, entity noun differs from base's.
      expect(entity.slotValue).toBe(base.slotValue);
      expect(entity.text).toContain(intent.altEntity);
      expect(entity.text).not.toContain(` ${intent.entity} `);
    }
  });

  it('passes assertNoPii over every expanded text', () => {
    const items = expandParaphraseSet(protocol.paraphraseSet);
    const blob = items.map((i) => i.text).join('\n');
    expect(() => assertNoPii(blob, 'paraphrase-set expansion')).not.toThrow();
  });
});
