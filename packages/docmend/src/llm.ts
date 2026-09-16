// The ONE spend step in docmend: prose-prerequisite. Every missing-prerequisite finding
// (D-prereq) can get a one-sentence prose suggestion via `callLlm` from @portfolio-builds/shared
// — never thrown, always ledgered, always [SIMULATED] at a confidence capped at 0.80, and
// never safe to auto-apply (a human reads LLM prose before it lands in a README). Tests and
// the default run pass a mock responder so this step runs at $0 (PB_SPEND_CAP_USD unset).

import { callLlm, capConfidence, MODELS, SIMULATED, type GatewayOptions } from '@portfolio-builds/shared';
import type { Finding, Proposal, ProposalTarget } from './types';
import { pendingReverify } from './types';
import { makeInsertionDiff, makeInsertionDiffAtLine } from './patch';

export const PREREQ_PURPOSE = 'docmend:prereq-prose';
export const PREREQ_MAX_TOKENS = 400;
export const PREREQ_MODEL = MODELS.sonnet;
export const PREREQ_BASE_CONFIDENCE = 0.75;

function systemPrompt(): string {
  return (
    'You write ONE short prose sentence to add to a README or docs page so a reader learns ' +
    'about a prerequisite (an environment variable or a command-line tool) before they reach ' +
    'a code block that uses it. Output only the sentence: no heading, no quotation marks, no ' +
    'preamble, no markdown formatting.'
  );
}

function userPrompt(finding: Finding): string {
  const kind = finding.evidence['kind'] === 'env' ? 'environment variable' : 'command-line tool';
  const name = (finding.evidence['name'] as string | undefined) ?? '(unknown)';
  return `The page's code uses the ${kind} "${name}" (line ${finding.line}: ${finding.excerpt}) without ever mentioning it in prose. Write the one sentence to add.`;
}

export interface LlmProposalResult {
  proposal: Proposal | null;
  error: string | null;
  costUsd: number;
  mock: boolean;
}

/**
 * Generates a prose-prerequisite proposal for one D-prereq finding. `raw` is the page's raw
 * content (used to anchor the insertion diff at the finding's own line); when that line is
 * not unique in `raw`, the proposal is still returned but with diff:null (never applicable,
 * still counted honestly against llm.calls / llm.errors by the caller via callLlm's ledger).
 */
export async function proposeProsePrerequisite(finding: Finding, raw: string, target: ProposalTarget, opts: GatewayOptions = {}): Promise<LlmProposalResult> {
  if (finding.checkId !== 'D-prereq') {
    return { proposal: null, error: 'not a D-prereq finding', costUsd: 0, mock: false };
  }
  const result = await callLlm({ system: systemPrompt(), user: userPrompt(finding), model: PREREQ_MODEL, maxTokens: PREREQ_MAX_TOKENS }, { ...opts, purpose: PREREQ_PURPOSE });

  if (result.error !== null || result.content === null) {
    return { proposal: null, error: result.error ?? 'empty response from gateway', costUsd: result.costUsd, mock: result.mock };
  }

  const sentence = result.content.trim();
  const confidence = capConfidence(PREREQ_BASE_CONFIDENCE, SIMULATED);
  // Insert AFTER the enclosing fence's closing line (never inside it — a sentence placed
  // between the backticks would read as code, not prose, and recheck-patched-text would
  // never see it). Falls back to anchoring on the excerpt itself when a finding predates
  // insertAfterLine (defense in depth; every current D-prereq finding sets it).
  const insertAfterLine = finding.evidence['insertAfterLine'] as number | undefined;
  const diffResult = insertAfterLine !== undefined ? makeInsertionDiffAtLine(raw, insertAfterLine, sentence) : makeInsertionDiff(raw, finding.excerpt, sentence);

  const proposal: Proposal = {
    id: `${finding.id}:prose-prerequisite`,
    findingId: finding.id,
    pageId: finding.pageId,
    category: 'prose-prerequisite',
    source: 'llm',
    independence: SIMULATED,
    confidence,
    model: result.model,
    safe_to_auto_apply: false,
    reason: 'LLM-authored prose is never safe to auto-apply; a human reviews it before it lands',
    evidence: { sentence, kind: finding.evidence['kind'], name: finding.evidence['name'] },
    edit: { line: finding.line, old: finding.excerpt, new: sentence },
    diff: diffResult.ok ? diffResult.diff : null,
    target,
    reverify: pendingReverify(),
  };
  return { proposal, error: null, costUsd: result.costUsd, mock: result.mock };
}
