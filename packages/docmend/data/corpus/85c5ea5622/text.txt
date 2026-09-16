# sop-mcp — Build Report

**Project:** P4 of the Victoria 4.0 Portfolio Projects Sprint (the stretch build).
**Built:** 2026-07-03 by Opus 4.8 (executor) under Victoria 4.0 governance.
**Scaffolded with:** the `anthropic-skills:mcp-builder` skill.
**Status:** executor-side Definition of Done met (see the evidence table). Remaining items
are Ryan's [EXTERNAL] gates (publish approval + optional live Claude Desktop GIF).

---

## What this is

A stdio MCP server that turns a folder of markdown SOP/FAQ documents into something an MCP
client (e.g. Claude Desktop) can search and cite. Read-only. No external services. It ships
with a working sample handbook and a two-minute, non-technical-admin install README.

**Differentiator (the wedge):** the "markdown KB → MCP" niche is saturated with
developer-oriented, general-knowledge-base servers. `sop-mcp` targets one job — a team's
SOPs/FAQs — installed by a non-technical admin, with a bundled sample handbook, a copy-paste
config, and troubleshooting for the three real failure modes. The README opens with that line.

## Locked scope — confirmed (IN/OUT is law)

**IN — all delivered:**
- TypeScript MCP server on the official `@modelcontextprotocol/sdk` (1.29.0), **stdio only**.
- Tools: `search_handbook(query, limit, response_format)` (keyword + heading match, excerpts
  with `file.md#heading` refs), `get_document(name, response_format)`, `list_documents(response_format)`.
- Each document exposed as an MCP **resource** (`sop://handbook/<file>`), enumerable via
  `resources/list`.
- Bundled sample handbook: **9** contractor-flavored SOP/FAQ markdown docs (fictional
  "Northwind Home Services").
- **Two-minute install README:** npx one-liner + exact Claude Desktop config JSON + the three
  real troubleshooting items + the "how this differs from docs-KB MCP servers" line.

**OUT — confirmed absent:**
- **OAuth** — none (no auth surface at all).
- **Remote / HTTP transport** — stdio only; the server never opens a socket.
- **Embeddings / vector search** — search is deterministic keyword + heading matching.
- **Write operations** — every tool is read-only; the server never writes to the handbook.

## Design notes

- **stdio hygiene:** all logging goes to **stderr**; stdout carries only the JSON-RPC stream.
- **Startup:** the handbook directory (CLI arg → `SOP_HANDBOOK_DIR` → bundled sample) is loaded
  and parsed once into memory; a missing/empty/unreadable dir exits 1 with an actionable message.
- **Path-traversal is structurally impossible.** `get_document` performs a pure in-memory map
  lookup keyed by document id; the caller's input never reaches the filesystem. Inputs containing
  `/`, `\`, `..`, or a null byte are rejected outright. The only reachable documents are the ones
  loaded at startup. (Covered by an explicit test with 9 attack strings.)
- **Response size:** a `CHARACTER_LIMIT` (25k) truncates human-readable output with a note;
  JSON output is never truncated mid-string (which would be invalid JSON) — `get_document`
  truncates its `content` field at the source so both formats stay consistent.
- **Tool annotations:** every tool is `readOnlyHint:true, destructiveHint:false,
  idempotentHint:true, openWorldHint:false`.
- **Modern SDK API only:** `registerTool` / `registerResource` with raw Zod input/output shapes
  and `structuredContent`; no deprecated `server.tool()` / manual request handlers.

## Evidence (Definition of Done)

| DoD item | Result | Evidence |
| --- | --- | --- |
| `npm test` green | **24/24 passed** (3 files: handbook, search, documents) | `docs/evidence/test-output.txt` |
| Scripted stdio session transcript | **11/11 assertions passed**; drives the built server over real stdio (tools/list, list_documents, search_handbook, get_document valid + traversal, resources/list, resources/read) | `docs/evidence/stdio-session-transcript.md` |
| Build compiles | `tsc` exit 0; `dist/index.js` runs; shebang preserved | (build log) |
| README two-minute test | both config snippets parse as JSON; `npm pack` ships README + dist + all 9 handbook docs (18 files) so zero-config `npx sop-mcp` works post-publish; steps walked, no gaps | this report + `npm pack --dry-run` |
| Scope-lock check | IN delivered; OUT (OAuth/HTTP/embeddings/writes) confirmed absent | this report |
| Sanitization grep clean | no absolute `/Users` paths, no real-identity handle/name patterns, no API-key/private-key patterns across the tree | grep (build log) |
| Local git clean | (at commit) single clean commit, sanitized noreply identity, no remote | capture-log |

### Test coverage summary
- **handbook.test.ts** — slugify; markdown parsing (H1 title, humanized fallback, section split,
  heading count, summary, section bodies/slugs); `loadHandbook` on the bundled sample (asserts
  8–10 docs, each with a title and ≥1 heading); actionable error on a missing directory.
- **search.test.ts** — tokenization (dedupe, short-token drop, empty); relevance (finds the
  warranty policy; ranks a title/heading match above a body-only mention); limit; no-match → [];
  every hit carries a `file_ref` citation, a non-empty excerpt, and a positive score.
- **documents.test.ts** — `resolveDocument` (id with/without `.md`, case/space-insensitive;
  unknown → null; **9 path-traversal/absolute/separator attacks → null**); list rendering;
  `applyCharacterLimit` passthrough + truncation.

## Verify it yourself

```bash
npm install
npm run build
npm test           # 24 unit tests
npm run session    # scripted stdio session → docs/evidence/stdio-session-transcript.md
# or drive it manually:
npx @modelcontextprotocol/inspector node dist/index.js ./handbook
```

## Remaining — Ryan [EXTERNAL] gates (not executor work)
- **Publish approval / G7:** public-repo flip + `npm publish` (name `sop-mcp` is currently free on
  npm — informational only; availability is re-checked at publish).
- **Optional live Claude Desktop demo** for the README's demo GIF (placeholder embedded).
- The literal `npx sop-mcp` round-trip requires the npm publish above; pre-publish, the identical
  code path is verified via `node dist/index.js` and the scripted stdio client.

## Honest boundaries
- The executor cannot install into Ryan's Claude Desktop or edit his app config; the in-app "first
  query" and GIF are his optional external step. The stdio transcript is the executor-side proof
  that the tools respond exactly as a client drives them.
- The sample handbook is fictional (faceless) and is treated as **data**; the server never executes
  document content.
