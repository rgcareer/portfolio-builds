// PII / secret sweep used by the tests that guard every committed snapshot and corpus.
// Deliberately over-inclusive: a false positive costs a look; a false negative publishes
// someone's data.

export type PiiKind = 'email' | 'phone' | 'uuid' | 'linkedin' | 'anthropic-key' | 'github-token' | 'aws-key' | 'private-key';

export interface PiiHit {
  kind: PiiKind;
  match: string;
  index: number;
}

const PATTERNS: ReadonlyArray<[PiiKind, RegExp]> = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  // North American phone shapes with separators; avoids plain long integers.
  ['phone', /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi],
  ['linkedin', /linkedin\.com\/in\/[A-Za-z0-9_-]+/gi],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];

export function findPii(text: string, kinds?: ReadonlyArray<PiiKind>): PiiHit[] {
  const hits: PiiHit[] = [];
  for (const [kind, re] of PATTERNS) {
    if (kinds && !kinds.includes(kind)) continue;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      hits.push({ kind, match: m[0], index: m.index ?? -1 });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Convenience for tests: throw with the first few hits if any PII is present. */
export function assertNoPii(text: string, label: string, kinds?: ReadonlyArray<PiiKind>): void {
  const hits = findPii(text, kinds);
  if (hits.length > 0) {
    const sample = hits.slice(0, 5).map((h) => `${h.kind}@${h.index}`).join(', ');
    throw new Error(`PII sweep failed for ${label}: ${hits.length} hit(s): ${sample}`);
  }
}
