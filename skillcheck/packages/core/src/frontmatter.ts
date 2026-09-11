import { load as yamlLoad, YAMLException } from 'js-yaml';

// The SINGLE frontmatter validator. Harvest uses it to set skills.frontmatter_valid;
// screen uses the same result to gate grading. One implementation so the harvested-N and
// graded-N definitions can never silently diverge (plan hole H11).
//
// A SKILL.md is valid when it opens with a `---` YAML frontmatter block that parses to a
// mapping containing non-empty string `name` and `description`. This mirrors the Claude
// Code skill contract's required keys.

export interface Frontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface FrontmatterResult {
  valid: boolean;
  frontmatter: Frontmatter | null;
  /** Content after the frontmatter block (the skill body). */
  body: string;
  errors: string[];
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(raw: string): FrontmatterResult {
  const text = raw.replace(/^\uFEFF/, ''); // strip a leading BOM
  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    return { valid: false, frontmatter: null, body: text, errors: ['no YAML frontmatter block'] };
  }

  const yamlText = m[1]!;
  const body = text.slice(m[0].length);

  let doc: unknown;
  try {
    doc = yamlLoad(yamlText);
  } catch (e) {
    const msg = e instanceof YAMLException ? e.message : String(e);
    return { valid: false, frontmatter: null, body, errors: [`YAML parse error: ${msg}`] };
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { valid: false, frontmatter: null, body, errors: ['frontmatter is not a mapping'] };
  }

  const obj = doc as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof obj['name'] !== 'string' || (obj['name'] as string).trim() === '') {
    errors.push('missing or empty `name`');
  }
  if (typeof obj['description'] !== 'string' || (obj['description'] as string).trim() === '') {
    errors.push('missing or empty `description`');
  }
  if (errors.length > 0) return { valid: false, frontmatter: null, body, errors };

  return { valid: true, frontmatter: obj as Frontmatter, body, errors: [] };
}
