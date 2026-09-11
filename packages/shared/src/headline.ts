// Headline rendering that cannot print a number that was not measured. A template holds
// `{name}` placeholders; values come from a committed run-meta object; rendering REFUSES
// (throws) on any unresolved placeholder, any non-finite number, any null/undefined/empty
// value, and any value that looks like a placeholder itself ("TBD", "TODO", "X%", "N=").
//
// Provenance: generalization (2026-09-10) of skillcheck/packages/publish/src/headline.ts,
// which rendered from run-meta.json so the number provably came from published data.

export type HeadlineValue = string | number;

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SUSPICIOUS_VALUE_RE = /^(?:tbd|todo|tba|xx+|n\/a|\?+|x%?|n=?)$/i;

export class HeadlineError extends Error {}

export function renderHeadline(template: string, values: Record<string, HeadlineValue | null | undefined>): string {
  const missing: string[] = [];
  const bad: string[] = [];
  const out = template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = values[name];
    if (v === null || v === undefined) {
      missing.push(name);
      return `{${name}}`;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) bad.push(`${name}=${String(v)}`);
      return String(v);
    }
    const s = String(v).trim();
    if (s === '' || SUSPICIOUS_VALUE_RE.test(s)) bad.push(`${name}=${JSON.stringify(v)}`);
    return s;
  });
  if (missing.length > 0) throw new HeadlineError(`headline: unresolved placeholder(s): ${missing.join(', ')}`);
  if (bad.length > 0) throw new HeadlineError(`headline: unmeasured or invalid value(s): ${bad.join(', ')}`);
  if (PLACEHOLDER_RE.test(out)) throw new HeadlineError('headline: a value re-introduced a placeholder');
  return out;
}

/** The placeholder names a template needs, in order of first appearance. */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) if (!names.includes(m[1]!)) names.push(m[1]!);
  return names;
}
