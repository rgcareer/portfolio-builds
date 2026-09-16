// out/report.md (or --format json): a deterministic rendering of run-meta.json +
// findings.json + proposals.json. The headline sentence is the ONLY place a number reaches
// the reader, and it goes through renderDocmendHeadline (which itself goes through
// renderHeadline) — this module never formats a number by hand.

import { stableStringify } from '@portfolio-builds/shared';
import type { Checks } from './protocol';
import type { PageFindings, Proposal } from './types';
import { renderDocmendHeadline, renderDocmendSubHeadline, type RunMeta } from './analyze';

export function renderReportMarkdown(runMeta: RunMeta, pageFindings: PageFindings[], proposals: Proposal[], checks: Checks): string {
  const lines: string[] = [];
  lines.push('# docmend report');
  lines.push('');
  lines.push(renderDocmendHeadline(checks.headline_template, runMeta, checks.no_proposals_text));
  lines.push('');
  if (runMeta.proposals.proposed > 0) {
    lines.push(renderDocmendSubHeadline(checks.sub_headline_template, runMeta));
    lines.push('');
  }

  lines.push('## Corpus');
  lines.push(`- Pages: ${runMeta.corpus.pages} (${runMeta.corpus.own} own-repo across ${runMeta.corpus.repos} repo(s), ${runMeta.corpus.sitePages} site, ${runMeta.corpus.ext} external)`);
  lines.push(`- Links checked: ${runMeta.drift.links} · Code blocks checked: ${runMeta.drift.snippets} · Version pins checked: ${runMeta.drift.pins}`);
  lines.push('');

  lines.push('## Drift by category');
  const cats = Object.keys(runMeta.drift.byCategory).sort();
  if (cats.length === 0) lines.push('- none found');
  else for (const c of cats) lines.push(`- ${c}: ${runMeta.drift.byCategory[c]}`);
  lines.push('');

  lines.push('## Proposals');
  if (proposals.length === 0) {
    lines.push('- none proposed yet');
  } else {
    const sorted = [...proposals].sort((a, b) => a.id.localeCompare(b.id));
    for (const p of sorted) {
      lines.push(`- \`${p.id}\` (${p.category}, page \`${p.pageId}\`): reverify=${p.reverify.status}, safe_to_auto_apply=${p.safe_to_auto_apply}, independence=${p.independence} — ${p.reason}`);
    }
  }
  lines.push('');

  lines.push('## Pages with the most drift');
  const worst = [...pageFindings]
    .map((pf) => ({ pageId: pf.pageId, counted: pf.findings.filter((f) => f.counted).length }))
    .filter((x) => x.counted > 0)
    .sort((a, b) => b.counted - a.counted || a.pageId.localeCompare(b.pageId))
    .slice(0, 10);
  if (worst.length === 0) lines.push('- none');
  else for (const w of worst) lines.push(`- \`${w.pageId}\`: ${w.counted} counted finding(s)`);
  lines.push('');

  lines.push('## LLM spend (docmend:prereq-prose)');
  lines.push(`- calls: ${runMeta.llm.calls} · errors: ${runMeta.llm.errors} · mock: ${runMeta.llm.mock} · cost: $${runMeta.llm.costUsd.toFixed(4)}`);
  lines.push('');

  lines.push('## Not measured');
  for (const nm of checks.not_measured) lines.push(`- ${nm}`);
  lines.push('');

  return lines.join('\n');
}

export interface ReportJson {
  runMeta: RunMeta;
  pageFindings: PageFindings[];
  proposals: Proposal[];
}

export function renderReportJson(runMeta: RunMeta, pageFindings: PageFindings[], proposals: Proposal[]): string {
  return stableStringify({ runMeta, pageFindings, proposals } satisfies ReportJson);
}
