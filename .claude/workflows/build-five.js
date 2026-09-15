export const meta = {
  name: 'build-five',
  description: 'Build the five portfolio apps from their specs (tests first), verify-and-fix, then fresh-context review + one fix pass',
  phases: [
    { title: 'Build', detail: 'one spec-builder per app (docmend in two passes)' },
    { title: 'Verify', detail: 'adversarial reviewer per app; one fix pass on a material gap' },
  ],
};

// Each app is an independent chain: build -> verify-and-fix -> review -> fix. No barrier — the
// only cross-app joins (gate, tests.json, commits) happen in the main session after this returns.
// Builders write only inside their own packages/<dir>/. Reserved files are the main session's.
const APPS = [
  { app: 'llm-cost-autopilot', dir: 'llm-cost-autopilot', model: 'claude-sonnet-5', passes: 1 },
  { app: 'semantic-cache', dir: 'semantic-cache', model: 'claude-sonnet-5', passes: 1 },
  { app: 'model-regress', dir: 'model-regress', model: 'claude-opus-4-8', passes: 1 },
  { app: 'agent-forensics', dir: 'agent-forensics', model: 'claude-opus-4-8', passes: 1 },
  { app: 'docmend', dir: 'docmend', model: 'claude-sonnet-5', passes: 2 },
];

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    status: { type: 'string', description: 'done | blocked | failed' },
    files_written: { type: 'array', items: { type: 'string' } },
    tests: {
      type: 'object',
      properties: { passed: { type: 'number' }, failed: { type: 'number' }, total: { type: 'number' } },
    },
    typecheck_ok: { type: 'boolean' },
    commands_run: {
      type: 'array',
      items: { type: 'object', properties: { cmd: { type: 'string' }, exit_code: { type: 'number' }, tail: { type: 'string' } } },
    },
    scope_violations: { type: 'array', items: { type: 'string' } },
    blocked_on: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['app', 'status'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    verdict: { type: 'string', description: 'no-material-gap | material-gap' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', description: 'correctness | security | requirement | nit' },
          file: { type: 'string' },
          line: { type: 'number' },
          issue: { type: 'string' },
          confidence: { type: 'string' },
        },
      },
    },
    evidence_checked: { type: 'array', items: { type: 'string' } },
  },
  required: ['app', 'verdict'],
};

function buildPrompt(a, attempt, priorNotes) {
  const base =
    `Build the package "${a.app}" in the portfolio-builds monorepo. First read tasks/conventions.md, then ` +
    `tasks/specs/${a.app}.md, then build EXACTLY what the spec names, tests first. Write only inside ` +
    `packages/${a.dir}/. Run \`npx vitest run packages/${a.dir}\` and \`npx tsc --noEmit\` yourself and ` +
    `iterate until both are green. Never run the network, npm install, the gate, git, or a real LLM call. ` +
    `Return the structured build result with the real tails of your last vitest and tsc runs.`;
  const two =
    a.passes === 2
      ? ` This package is large: complete PASS A (protocol files, the OTR copies + drift-guard, snippets, ` +
        `sources, snapshot, lookup, checks + their tests) AND PASS B (propose, llm mock, patch, reverify, ` +
        `analyze, report, CLI + their tests) in this single turn; do not stop after Pass A.`
      : '';
  const retry = attempt > 0 ? ` Your previous attempt did not finish cleanly. Failure detail: ${priorNotes}. Fix it and complete the build.` : '';
  return base + two + retry;
}

function clean(b) {
  return b && b.status === 'done' && b.typecheck_ok === true && b.tests && (b.tests.failed ?? 1) === 0 && (b.scope_violations ?? []).length === 0;
}

async function build(a) {
  let b = await agent(buildPrompt(a, 0, ''), { agentType: 'spec-builder', model: a.model, effort: 'xhigh', label: `build:${a.app}`, phase: 'Build', schema: BUILD_SCHEMA });
  return { a, b };
}

async function verifyFix({ a, b }) {
  let attempt = 0;
  let cur = b;
  while (!clean(cur) && attempt < 2) {
    attempt++;
    const detail = cur ? `status=${cur.status}; tests=${JSON.stringify(cur.tests)}; typecheck_ok=${cur.typecheck_ok}; notes=${cur.notes ?? ''}; blocked_on=${cur.blocked_on ?? ''}` : 'no result returned';
    log(`verify-fix ${a.app}: attempt ${attempt} (prior not clean: ${detail.slice(0, 160)})`);
    cur = await agent(buildPrompt(a, attempt, detail), { agentType: 'spec-builder', model: a.model, effort: 'xhigh', label: `fix:${a.app}#${attempt}`, phase: 'Build', schema: BUILD_SCHEMA });
  }
  if (!clean(cur)) log(`verify-fix ${a.app}: STILL NOT CLEAN after ${attempt} fixes — flagged for the main session`);
  return { a, b: cur };
}

async function review({ a, b }) {
  const r = await agent(
    `Fresh-context adversarial review of the package "${a.app}" against tasks/specs/${a.app}.md and ` +
      `tasks/conventions.md. Read packages/${a.dir}/ cold. Flag only gaps that affect correctness, security, ` +
      `or the stated requirements (real-numbers rule, headline-from-run-meta, [SIMULATED] cap, redaction, ` +
      `protocol freeze, repro determinism, spend cap). Ignore style. Verdict material-gap only for a real ` +
      `correctness/security/requirement gap.`,
    { agentType: 'reviewer', model: 'claude-opus-4-8', effort: 'high', label: `review:${a.app}`, phase: 'Verify', schema: REVIEW_SCHEMA },
  );
  return { a, b, r };
}

async function fix({ a, b, r }) {
  if (!r || r.verdict !== 'material-gap') return { a, b, r, fixed: false };
  if (budget.total && budget.remaining() < 300_000) {
    log(`fix ${a.app}: material gap but budget low (${Math.round(budget.remaining() / 1000)}k) — deferring to the main session`);
    return { a, b, r, fixed: false, deferred: true };
  }
  const detail = (r.findings ?? []).map((f) => `[${f.severity}] ${f.file}:${f.line ?? '?'} ${f.issue}`).join(' | ');
  log(`fix ${a.app}: applying one pass for material gap: ${detail.slice(0, 200)}`);
  const b2 = await agent(
    `The reviewer found a material gap in "${a.app}": ${detail}. Read tasks/specs/${a.app}.md, fix ONLY these ` +
      `gaps inside packages/${a.dir}/, re-run \`npx vitest run packages/${a.dir}\` and \`npx tsc --noEmit\`, ` +
      `and return the structured build result.`,
    { agentType: 'spec-builder', model: a.model, effort: 'xhigh', label: `review-fix:${a.app}`, phase: 'Verify', schema: BUILD_SCHEMA },
  );
  return { a, b: b2, r, fixed: true };
}

const results = await pipeline(APPS, build, verifyFix, review, fix);

const summary = results.filter(Boolean).map((x) => ({
  app: x.a.app,
  build_status: x.b?.status ?? 'null',
  tests: x.b?.tests ?? null,
  typecheck_ok: x.b?.typecheck_ok ?? null,
  clean: clean(x.b),
  review_verdict: x.r?.verdict ?? 'none',
  review_findings: (x.r?.findings ?? []).length,
  fixed: x.fixed ?? false,
  deferred: x.deferred ?? false,
  scope_violations: x.b?.scope_violations ?? [],
}));
log(`build-five done: ${summary.filter((s) => s.clean).length}/${summary.length} clean`);
return { summary };
