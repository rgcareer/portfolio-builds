// Shared data model for docmend: findings from the drift checks, proposals a mechanical or
// LLM step generates for them, and the run-level aggregate. See tasks/specs/docmend.md
// "Data model" for the contract this mirrors exactly.

export type DriftCategory =
  | 'broken-link'
  | 'redirected-link'
  | 'stale-pin'
  | 'version-drift'
  | 'missing-prerequisite'
  | 'broken-relative-path'
  | 'broken-script'
  | 'engine-mismatch'
  | 'placeholder-text'
  | 'unparseable-snippet';

/** JSON-serializable evidence bag; shape varies per check. */
export type Evidence = Record<string, unknown>;

export interface Finding {
  id: string;
  pageId: string;
  checkId: string;
  category: DriftCategory;
  /** 1-based line in the page text; 0 when the finding is page-level. */
  line: number;
  /** Verbatim excerpt from that line (<= 200 chars). */
  excerpt: string;
  detail: string;
  /** Whether this finding counts against the drift total (informational findings do not). */
  counted: boolean;
  evidence: Evidence;
}

export type ProposalSource = 'mechanical' | 'llm';
export type Independence = 'measured' | '[SIMULATED]';
export type ProposalCategory = 'redirect-rewrite' | 'pin-bump' | 'path-rewrite' | 'prose-prerequisite';

export interface ProposalEdit {
  line: number;
  old: string;
  new: string;
}

export type TargetKind = 'repo-file' | 'live-page' | 'external-snapshot';

export interface ProposalTarget {
  kind: TargetKind;
  /** Own-repo id (matches protocol own_repos[].id), or null for a non-repo target. */
  repo: string | null;
  path: string;
  prReady: boolean;
}

export type ReverifyStatus = 'pass' | 'fail' | 'skipped';

export interface ReverifyResult {
  status: ReverifyStatus;
  methods: string[];
  evidence: Evidence;
  checkedAt: string | null;
}

export function pendingReverify(): ReverifyResult {
  return { status: 'skipped', methods: [], evidence: {}, checkedAt: null };
}

export interface Proposal {
  id: string;
  findingId: string;
  pageId: string;
  category: ProposalCategory;
  source: ProposalSource;
  independence: Independence;
  confidence: number | null;
  model: string | null;
  safe_to_auto_apply: boolean;
  reason: string;
  evidence: Evidence;
  edit: ProposalEdit;
  /** Unified diff text, or null when a diff could not be made (e.g. ambiguous location). */
  diff: string | null;
  target: ProposalTarget;
  reverify: ReverifyResult;
}

export type PageSourceKind = 'own-repo' | 'site' | 'external';

/** One page's scan result: findings.json is an array of these. */
export interface PageFindings {
  pageId: string;
  source: PageSourceKind;
  repo: string | null;
  path: string;
  findings: Finding[];
  stats: { installs: number; pins: number; snippets: number; linksChecked: number };
}

export interface PageRef {
  pageId: string;
  source: PageSourceKind;
  /** Own-repo id, site id, or external pointer id (protocol-scoped, never a raw filesystem path). */
  sourceId: string;
  /** Repo id (own-repo only) so proposals/patches can target the right tree. */
  repo: string | null;
  /** Relative path within the repo (own-repo), or the page URL (site/external). */
  path: string;
  url: string | null;
}
