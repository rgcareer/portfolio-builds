// Expands the frozen paraphrase-set protocol into concrete labelled texts. Labels are true
// by construction: a paraphrase always shares its base's slot value (same referent, reworded);
// a slot-swap negative always resolves to a DIFFERENT slot value than its base; a polarity
// negative always inserts a negation word; an entity negative always swaps the entity noun.
// No LLM authors or judges any of this — it is pure, deterministic string substitution.

import { mulberry32 } from '@portfolio-builds/shared';
import type { ParaphraseSet, IntentDef } from './protocol';

export type ItemRole = 'base' | 'paraphrase' | 'negative';
export type NegativeKind = 'slot-swap' | 'polarity' | 'entity';

export interface LabeledItem {
  id: string;
  intentId: string;
  domain: string;
  role: ItemRole;
  kind?: NegativeKind;
  text: string;
  /** The concrete slot value resolved into this item's text. */
  slotValue: string;
}

function render(template: string, slotName: string, value: string): string {
  return template.replaceAll(`{${slotName}}`, value);
}

/** Picks a deterministic index in [0, vocab.length) different from `avoidIndex` (when possible). */
function pickAltIndex(rng: () => number, length: number, avoidIndex: number): number {
  if (length <= 1) return avoidIndex;
  let idx = Math.floor(rng() * (length - 1));
  if (idx >= avoidIndex) idx += 1;
  return idx;
}

function expandIntent(intent: IntentDef, slotName: string, rng: () => number): LabeledItem[] {
  const vocab = intent.base.slots[slotName];
  if (!vocab || vocab.length === 0) throw new Error(`labelset: intent ${intent.id} has no slot vocab for "${slotName}"`);

  const baseIdx = Math.floor(rng() * vocab.length);
  const baseSlot = vocab[baseIdx]!;
  const altIdx = pickAltIndex(rng, vocab.length, baseIdx);
  const altSlot = vocab[altIdx]!;

  const items: LabeledItem[] = [];
  items.push({
    id: `${intent.id}:base`,
    intentId: intent.id,
    domain: intent.domain,
    role: 'base',
    text: render(intent.base.template, slotName, baseSlot),
    slotValue: baseSlot,
  });

  intent.paraphrases.forEach((tpl, i) => {
    items.push({
      id: `${intent.id}:paraphrase:${i}`,
      intentId: intent.id,
      domain: intent.domain,
      role: 'paraphrase',
      text: render(tpl, slotName, baseSlot),
      slotValue: baseSlot,
    });
  });

  intent.negatives.forEach((neg, i) => {
    const slot = neg.kind === 'slot-swap' ? altSlot : baseSlot;
    items.push({
      id: `${intent.id}:negative:${neg.kind}:${i}`,
      intentId: intent.id,
      domain: intent.domain,
      role: 'negative',
      kind: neg.kind,
      text: render(neg.template, slotName, slot),
      slotValue: slot,
    });
  });

  return items;
}

/**
 * Deterministically expands every intent's base/paraphrases/negatives into concrete texts.
 * A single PRNG stream (seeded from `protocol.seed`) is advanced across intents in file
 * order, so calling this twice on the same protocol always yields identical output.
 */
export function expandParaphraseSet(protocol: ParaphraseSet): LabeledItem[] {
  const rng = mulberry32(protocol.seed);
  const out: LabeledItem[] = [];
  for (const intent of protocol.intents) out.push(...expandIntent(intent, protocol.slotName, rng));
  return out;
}
