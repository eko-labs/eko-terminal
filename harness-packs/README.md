# EKO harness packs

`pack.yaml` is the single source. `pnpm packs:build` writes `generated/`, and
`GET /v1/packs` serves the same templates, with the endpoint filled in when the
API has `MCP_PUBLIC_URL`. The Connect page in Mission Control fills in the key.
The endpoint below is the staging one; replace `<YOUR_KEY>` with the harness API
key Mission Control shows once.

Before any client:

1. Sign in with your wallet. In Settings, Privacy & data, turn on the agent
   journal. Preflight records every check there, so without it `preflight` and
   `journal` refuse and tell the agent to ask you.
2. In Mission Control, Connect: create an agent and generate its key.

## Claude Code

Run in your project folder:

```sh
claude mcp add --transport http eko https://mcp.ekoterminal.com/mcp --header "Authorization: Bearer <YOUR_KEY>"
```

`claude mcp list` (or `/mcp` inside Claude Code) shows `eko` connected. Add the
harness instructions (`generated/claude_code/instructions.md`) to `CLAUDE.md`, or
install `generated/claude_code/.claude/skills/eko/SKILL.md` as the `eko` skill.
Then ask the agent to start a session with `journal`.

## Claude Desktop

Claude Desktop's config file starts local programs only, and its hosted custom
connector needs OAuth, which stays off until task 099 is accepted. Until then it
reaches EKO through the open-source `mcp-remote` bridge (Node.js 18 or later on
your PATH). Open Settings, Developer, Edit Config and add the `eko` entry to
`mcpServers`, keeping any servers already there:

```json
{
  "mcpServers": {
    "eko": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.ekoterminal.com/mcp", "--header", "Authorization:${EKO_AUTH_HEADER}"],
      "env": { "EKO_AUTH_HEADER": "Bearer <YOUR_KEY>" }
    }
  }
}
```

Keep `${EKO_AUTH_HEADER}` exactly as written: the bridge reads it from `env`, which
keeps the space out of the arguments (Claude Desktop on Windows splits them).
Quit and reopen Claude Desktop, put the harness instructions in a project's
instructions, and check that the `eko` tools are listed in a new chat.

## Tools

| Tool | What it returns |
|---|---|
| `coin_verdict` | Buyer-risk verdict for a Robinhood Chain token: level, reasons, playbooks (`version: 2` for Guard V2) |
| `coin_card` | The coin card, with buyer flow for `flowWindow` (beta; `meta.flow.unavailable` marks an unmeasured window) |
| `playbook_match` | Matched risk playbooks at or above `minLevel` |
| `census_summary` | The flow Census; gate status and methodology only until label precision passes its gate |
| `receipts_lookup` | Receipt hash, pending or anchored status and proof metadata |
| `preflight` | Advisory `allow`, `deny` or `needs_approval` for one order against your policy |
| `journal` | A private, encrypted journal entry (`session_start`, `decision`, `order`, `outcome`, `note`) |

Every result carries `structuredContent` and a JSON copy as text for clients that
show the model only text. Third-party token text appears only inside `Untrusted`
fields, and the text copy withholds it. EKO's checks are advisory: EKO never
places orders, and Robinhood's own trade approvals, when on, remain the enforced
stop. Built on Robinhood Chain. Not affiliated with, endorsed by, or officially
connected with Robinhood Markets, Inc.
