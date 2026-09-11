import { createHmac } from 'node:crypto';
import { verdictFor, safetyTier, type Tier, type Verdict, type Severity } from '@skillcheck/screen';

// The disclosure redaction choke-point. ALL published data flows through redact() before
// any file is written, so a page template can never see an unredacted gated skill — the
// unredacted row simply never reaches site/src/data. A skill with a qualifying (critical)
// finding that has not completed the 14-day disclosure flow is FULLY anonymized: no repo,
// path, name, evidence, or grade leaves the system — only an anonymized stub (so its
// existence stays countable, resisting subtraction attacks) and its findings reduced to
// pack + severity. Naming a dangerous skill is gated on a human `disclose release`.

export const DISCLOSURE_SEVERITIES: readonly string[] = ['critical'];

export type DisclosureStatus = 'pending_notice' | 'notified' | 'disclosed' | 'resolved' | 'withdrawn';

export interface RawSkill {
  id: string;
  repo: string;
  path: string;
  name: string | null;
  source: string;
  repoStars: number | null;
  safety: Tier;
  hygiene: Tier;
  abandoned: boolean;
}

export interface RawFinding {
  skillId: string;
  ruleId: string;
  pack: string;
  severity: string;
  file: string;
  line: number;
  col: number;
  matched: string;
  context: string;
  message: string;
}

export interface PublicSkill {
  id: string;
  anonymized: boolean;
  repo: string | null;
  path: string | null;
  name: string | null;
  source: string;
  stars: number | null;
  safety: Tier | 'under_review';
  hygiene: Tier | 'under_review';
  effectiveness: 'not_yet_benchmarked';
  honesty: 'not_yet_benchmarked';
  verdict: Verdict;
  abandoned: boolean;
  findingCount: number;
  withheldFindingCount: number;
}

export interface PublicFinding {
  skillId: string;
  anonymized: boolean;
  ruleId: string;
  pack: string;
  severity: string;
  file: string | null;
  line: number | null;
  col: number | null;
  matched: string | null;
  context: string | null;
  message: string | null;
}

export interface RedactResult {
  skills: PublicSkill[];
  findings: PublicFinding[];
  gatedCount: number;
  withheldFindingCount: number;
}

export function placeholderId(salt: string, skillId: string): string {
  return 'SC-ANON-' + createHmac('sha256', salt).update(skillId).digest('hex').slice(0, 8);
}

function isQualifying(severity: string): boolean {
  return DISCLOSURE_SEVERITIES.includes(severity);
}

function findingSortKey(f: RawFinding): string {
  return [f.ruleId, f.file, String(f.line).padStart(9, '0'), String(f.col).padStart(9, '0'), f.matched].join(' ');
}

export function redact(
  skills: RawSkill[],
  findings: RawFinding[],
  disclosure: Map<string, DisclosureStatus>,
  salt: string,
): RedactResult {
  const bySkill = new Map<string, RawFinding[]>();
  for (const f of findings) {
    const arr = bySkill.get(f.skillId);
    if (arr) arr.push(f);
    else bySkill.set(f.skillId, [f]);
  }

  const outSkills: PublicSkill[] = [];
  const outFindings: PublicFinding[] = [];
  let gatedCount = 0;
  let withheldFindingCount = 0;

  const ordered = skills.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const s of ordered) {
    const sf = (bySkill.get(s.id) ?? []).slice().sort((a, b) => (findingSortKey(a) < findingSortKey(b) ? -1 : 1));
    const hasQualifying = sf.some((f) => isQualifying(f.severity));
    const status = disclosure.get(s.id);
    const withdrawn = status === 'withdrawn';
    const disclosed = status === 'disclosed';
    const gated = hasQualifying && !disclosed && !withdrawn;

    if (gated) {
      gatedCount++;
      withheldFindingCount += sf.length;
      const pid = placeholderId(salt, s.id);
      outSkills.push({
        id: pid,
        anonymized: true,
        repo: null,
        path: null,
        name: null,
        source: s.source,
        stars: null,
        safety: 'under_review',
        hygiene: 'under_review',
        effectiveness: 'not_yet_benchmarked',
        honesty: 'not_yet_benchmarked',
        verdict: 'under_review',
        abandoned: s.abandoned,
        findingCount: 0,
        withheldFindingCount: sf.length,
      });
      for (const f of sf) {
        outFindings.push({
          skillId: pid,
          anonymized: true,
          ruleId: f.ruleId,
          pack: f.pack,
          severity: f.severity,
          file: null,
          line: null,
          col: null,
          matched: null,
          context: null,
          message: null,
        });
      }
      continue;
    }

    // withdrawn → drop its qualifying finding(s) (false positive) and recompute safety.
    const shown = withdrawn ? sf.filter((f) => !isQualifying(f.severity)) : sf;
    const safety = withdrawn ? safetyTier(shown as { severity: Severity }[]) : s.safety;

    outSkills.push({
      id: s.id,
      anonymized: false,
      repo: s.repo,
      path: s.path,
      name: s.name,
      source: s.source,
      stars: s.repoStars,
      safety,
      hygiene: s.hygiene,
      effectiveness: 'not_yet_benchmarked',
      honesty: 'not_yet_benchmarked',
      verdict: verdictFor(safety, s.hygiene),
      abandoned: s.abandoned,
      findingCount: shown.length,
      withheldFindingCount: 0,
    });
    for (const f of shown) {
      outFindings.push({
        skillId: s.id,
        anonymized: false,
        ruleId: f.ruleId,
        pack: f.pack,
        severity: f.severity,
        file: f.file,
        line: f.line,
        col: f.col,
        matched: f.matched,
        context: f.context,
        message: f.message,
      });
    }
  }

  return { skills: outSkills, findings: outFindings, gatedCount, withheldFindingCount };
}
