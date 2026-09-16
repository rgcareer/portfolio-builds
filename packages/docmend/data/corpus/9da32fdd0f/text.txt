# sop-mcp — turn your team's handbook into something Claude can answer from

**Point it at a folder of markdown SOPs and FAQs, and anyone on your team can ask
Claude questions about the handbook — with a citation back to the exact document.**
No coding, no database, no cloud account. If you can edit one config file, you can
turn it on in about two minutes.

> **How this is different from the other "markdown → MCP" servers.** Most of them are
> general knowledge-base tools aimed at developers. `sop-mcp` is built for one job: a
> team's **standard operating procedures and FAQs**, installed by a **non-technical
> admin**. It ships with a working sample handbook, a copy-paste Claude Desktop config,
> and troubleshooting for the three things that actually go wrong — so the person who
> owns the handbook can set it up without asking engineering.

<!-- Demo GIF placeholder — drop a ~20s Claude Desktop capture here at publish:
![sop-mcp answering a handbook question in Claude Desktop](docs/evidence/demo.gif) -->

_A short demo GIF (Claude Desktop answering a handbook question) goes here at publish time._

---

## Try it in two minutes

**You need:** [Node.js 20 or newer](https://nodejs.org) and [Claude Desktop](https://claude.ai/download).

**1. Open your Claude Desktop config file:**

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

(If the file doesn't exist yet, create it. In Claude Desktop you can also click
**Settings → Developer → Edit Config** to open it.)

**2. Add `sop-mcp` and save.** To try the built-in sample handbook first (no folder to
set up), paste exactly this:

```json
{
  "mcpServers": {
    "team-handbook": {
      "command": "npx",
      "args": ["-y", "sop-mcp"]
    }
  }
}
```

When you're ready to use **your own** handbook, point it at your folder of `.md` files
by adding the path as the last argument:

```json
{
  "mcpServers": {
    "team-handbook": {
      "command": "npx",
      "args": ["-y", "sop-mcp", "/absolute/path/to/your/handbook"]
    }
  }
}
```

**3. Fully quit and reopen Claude Desktop.** Then ask it something your handbook covers:

> *"What's our labor warranty?"* · *"How do we handle a billing complaint?"* ·
> *"What counts as an after-hours emergency?"*

Claude will search the handbook and answer **with the document it pulled the answer
from.** That's it — you're done.

---

## What your team can now do

`sop-mcp` gives Claude three read-only tools and exposes each document as a resource:

| Tool | What it does |
| --- | --- |
| `search_handbook` | Find the most relevant sections for a question, with a `file.md#heading` citation. |
| `list_documents` | See every document in the handbook, with a one-line summary. |
| `get_document` | Read one full document by name. |

Everything is **read-only** — `sop-mcp` can search and quote the handbook, but it can
never change, delete, or add to your files.

## Your handbook is just a folder of markdown

There is nothing to import. A handbook is a folder of `.md` files — one document per
file. Give each file a clear name (it becomes the document's id) and start it with a
`# Title` heading. Use `##` sub-headings for the sections people actually ask about;
`sop-mcp` searches those headings first, so good headings make search better.

The bundled [`handbook/`](handbook/) folder is a complete, realistic example (a fictional
home-services contractor) you can copy and edit.

---

## Troubleshooting — the three things that actually go wrong

1. **"It can't find my handbook."** The path must be **absolute**. Use
   `/Users/you/Documents/handbook` (macOS) or `C:\\Users\\you\\handbook` (Windows) —
   not `./handbook`, not `~/handbook`. Claude Desktop does not expand `~` or relative
   paths.
2. **"Nothing happens / npx errors."** You need **Node 20+**. Check with `node -v` in a
   terminal; if it's missing or older, install the LTS from
   [nodejs.org](https://nodejs.org). The very first launch also downloads the package,
   which can take a few seconds — if the server didn't appear, wait and restart Claude
   Desktop once.
3. **"Claude doesn't see the server."** Config changes only load on a **full restart** —
   quit Claude Desktop completely (not just the window) and reopen it. If it's still
   missing, check the MCP logs (**Settings → Developer**, or the `mcp*.log` files next to
   the config) for a startup error — a bad handbook path is the usual culprit.

---

## What this is NOT

`sop-mcp` is deliberately small, so it stays easy to trust and install. It does **not**:

- **No writes.** It only reads your handbook. It cannot edit, delete, or create files.
- **No cloud, no account, no OAuth.** It runs locally as a subprocess of your MCP client
  over stdio. Nothing is uploaded and there is nothing to log into.
- **No HTTP/remote server.** stdio only. It is not a hosted web service.
- **No embeddings or "AI search."** Search is fast, deterministic keyword + heading
  matching — no vector database, no per-query API cost, no surprise bills.
- **No formats besides markdown.** Point it at `.md` files. (Convert PDFs/Docs to markdown
  first if you need them.)

If you need a hosted, multi-tenant, semantic-search knowledge base, `sop-mcp` is the wrong
tool — and that's fine.

## Run from source

Before it's on npm, or to develop against it:

```bash
npm install
npm run build                 # compile to dist/
npm test                      # unit tests (24)
npm run session               # scripted stdio session → docs/evidence/ transcript
node dist/index.js ./handbook # run the server directly against a folder
```

To point Claude Desktop at a local build, use `"command": "node"` and
`"args": ["/absolute/path/to/dist/index.js", "/absolute/path/to/handbook"]`.

## License

MIT. Built by Ryan / Get Smart AI.
