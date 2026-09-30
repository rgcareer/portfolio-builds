# Build specs

These are the specs the builder agents worked from — committed as written before each build,
lightly scrubbed of local filesystem paths. Each one names the package's tests-first
deliverables, its frozen-protocol requirements, and what the builder was and wasn't allowed to
touch. The workflow that consumed them is in [`.claude/workflows`](../../.claude/workflows);
the calls that changed mid-build are in [DECISIONS.md](../../DECISIONS.md).

| Spec | Package |
|---|---|
| [llm-cost-autopilot.md](llm-cost-autopilot.md) | [`@rgcareer/llm-cost-autopilot`](../../packages/llm-cost-autopilot) |
| [semantic-cache.md](semantic-cache.md) | [`@rgcareer/semantic-cache`](../../packages/semantic-cache) |
| [model-regress.md](model-regress.md) | [`@rgcareer/model-regress`](../../packages/model-regress) |
| [agent-forensics.md](agent-forensics.md) | [`@rgcareer/agent-forensics`](../../packages/agent-forensics) |
| [docmend.md](docmend.md) | [`@rgcareer/docmend`](../../packages/docmend) |
