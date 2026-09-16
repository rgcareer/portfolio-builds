export const meta = {
  name: 'audit-docs-review',
  description: 'For each built app with real data: independently re-derive its numbers, write its docs from generator output, then fresh-context review',
  phases: [
    { title: 'Audit', detail: 'number-auditor re-derives every headline from committed data' },
    { title: 'Docs', detail: 'docs-writer fills README/CHANGELOG/SECURITY/case-study from generator output' },
    { title: 'FinalReview', detail: 'fresh-context reviewer on the finished package' },
  ],
};

// APPS may be narrowed by args.only (an array of app names) when only some have real data yet.
const ALL = ['llm-cost-autopilot', 'semantic-cache', 'model-regress', 'agent-forensics', 'docmend'];
const DIRS = {
  'llm-cost-autopilot': 'llm-cost-autopilot',
  'semantic-cache': 'semantic-cache',
  'model-regress': 'model-regress',
  'agent-forensics': 'agent-forensics',
  docmend: 'docmend',
};
const APPS = Array.isArray(args?.only) && args.only.length ? ALL.filter((a) => args.only.includes(a)) : ALL;

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    numbers: {
      type: 'array',
      items: { type: 'object', properties: { claim: { type: 'string' }, location: { type: 'string' }, recomputed: { type: 'string' }, matches: { type: 'boolean' }, method: { type: 'string' } } },
    },
    protocol_chain_ok: { type: 'boolean' },
    spend_ledger_usd: { type: 'number' },
    simulated_labelled_ok: { type: 'boolean' },
    material_gaps: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', description: 'ok | material-gap' },
  },
  required: ['app', 'verdict'],
};

const DOCS_SCHEMA = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    generator_outputs_used: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, output: { type: 'string' } } } },
    humanizer_pass: { type: 'boolean' },
    hand_typed_numbers: { type: 'number' },
  },
  required: ['app', 'files'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    verdict: { type: 'string', description: 'no-material-gap | material-gap' },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' }, issue: { type: 'string' } } } },
  },
  required: ['app', 'verdict'],
};

async function numberAudit(app) {
  const r = await agent(
    `Invoke the Skill tool for portfolio-builds-conventions first. You are READ-ONLY: never edit or write a file. ` +
      `Audit every portfolio-facing number in the package "${app}". Read tasks/conventions.md, then ` +
      `packages/${DIRS[app]}/{README.md,case-study.md,protocol/*.json,data/run-meta.json} and any ` +
      `findings/comparison/curve files. Recompute each number from the committed data with your OWN node -e ` +
      `one-liners (never the app's code), recompute each Wilson interval, confirm the headline equals the ` +
      `renderHeadline output, confirm the protocol commit predates the data timestamp, confirm the ledger ` +
      `total is within the named step's cap, and confirm every [SIMULATED] value is labelled, capped 0.80, and ` +
      `absent from the headline.`,
    { agentType: 'researcher', model: 'claude-opus-4-8', effort: 'high', label: `audit:${app}`, phase: 'Audit', schema: AUDIT_SCHEMA },
  );
  return { app, audit: r };
}

async function docs({ app, audit }) {
  if (budget.total && budget.remaining() < 250_000) {
    log(`docs ${app}: budget low (${Math.round(budget.remaining() / 1000)}k) — deferring docs to the main session`);
    return { app, audit, docs: null, deferred: true };
  }
  const d = await agent(
    `Invoke the Skill tool for humanizer and portfolio-builds-conventions first. ` +
      `Write the portfolio docs for "${app}". Read tasks/conventions.md and packages/${DIRS[app]}/ (spec, ` +
      `source, protocol, data/run-meta.json). Produce README.md, CHANGELOG.md, SECURITY.md, and case-study.md ` +
      `per the docs-writer contract. EVERY number must come from running the package's own commands ` +
      `(\`node --import tsx packages/${DIRS[app]}/src/cli.ts headline\` and \`... report --format md\`) and be ` +
      `pasted verbatim; if a command errors or no run exists, write "Not yet measured." and leave metrics empty. ` +
      `Run the humanizer over all prose. hand_typed_numbers must be 0.`,
    { agentType: 'general-purpose', model: 'claude-sonnet-5', effort: 'medium', label: `docs:${app}`, phase: 'Docs', schema: DOCS_SCHEMA },
  );
  return { app, audit, docs: d };
}

async function finalReview({ app, audit, docs, deferred }) {
  const r = await agent(
    `Fresh-context final review of the finished package "${app}" against tasks/specs/${app}.md. Read ` +
      `packages/${DIRS[app]}/ cold including README.md and case-study.md. Flag only correctness/security/` +
      `requirement gaps, especially any number in the docs that is not backed by run-meta.json, any missing ` +
      `interval, any [SIMULATED] value in a headline, or any raw prompt/path/id in committed data. Ignore style.`,
    { agentType: 'reviewer', model: 'claude-opus-4-8', effort: 'high', label: `final:${app}`, phase: 'FinalReview', schema: REVIEW_SCHEMA },
  );
  return { app, audit, docs, review: r, deferred: deferred ?? false };
}

const results = await pipeline(APPS, numberAudit, docs, finalReview);

const summary = results.filter(Boolean).map((x) => ({
  app: x.app,
  audit_verdict: x.audit?.verdict ?? 'none',
  audit_gaps: (x.audit?.material_gaps ?? []).length,
  spend_ledger_usd: x.audit?.spend_ledger_usd ?? null,
  docs_files: (x.docs?.files ?? []).length,
  hand_typed_numbers: x.docs?.hand_typed_numbers ?? null,
  docs_deferred: x.deferred,
  review_verdict: x.review?.verdict ?? 'none',
  review_findings: (x.review?.findings ?? []).length,
}));
log(`audit-docs-review done for ${summary.length} apps`);
return { summary };
