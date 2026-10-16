# Try the demo with Claude

This guide walks you through the fastest way to see NoPM in action: log into the live demo, hand Claude a key to it, and watch an AI agent do real project-management work with a governed audit trail behind every move.

You will need a Claude account (Claude Desktop, Claude Code, or claude.ai) capable of connecting to an MCP (Model Context Protocol) server. MCP is the open standard that lets an AI assistant call an application's tools directly, instead of you copy-pasting into a chat window.

## Step 1: Open the demo and log in

Go to **stillnotbald.com**. On the login page, do not fill in an email or password. Click the button labeled **"Try the live demo →"**. It signs you in instantly as a pre-seeded demo account, with the role of manager: it can decide on other people's work but never its own. That matters for step 3's "what you cannot do" box below. There are no credentials to type in; the button does the sign-in for you against a demo account the site configures on its own.

You land on `/dashboard`. Everything you see, including projects, tasks, and budgets, is real seeded demo data, not a screenshot.

> **Demo terms, in short:** the hosted demo has no uptime guarantee, everyone who clicks "Try the live demo" shares the same account, and the workspace is reseeded and wiped periodically. Do not put real client data, real email addresses, or real payment details into it. See the "word about the live demo" note at the end of this guide.

## Step 2: Mint a scoped access token

Before Claude can touch anything, it needs its own key, called a **Personal Access Token (PAT)**. A PAT is scoped, meaning it can only do the specific things you allow (for example, "read tasks" but not "delete projects").

1. Open **Settings → API Tokens** (or navigate to `/tokens`).
2. Find the **"Connect your agent"** card and its **"Mint scoped PAT"** tab.
3. Give it a name (e.g. "Claude") and mint it. There is also a ready-made **least-privilege agent preset**: every read scope plus the ability to edit tasks, but nothing that can delete, approve, or administer anything.
4. **Copy the token immediately.** It is shown to you exactly once, right after minting, and never again. If you lose it, you mint a new one. NoPM never stores or displays the raw token after that first screen.

Treat this token like a password. Do not paste it into a public chat, commit it to a public repository, or share it with anyone you would not hand your email password to.

## Step 3: Connect Claude

NoPM supports three ways to connect an MCP client. Pick whichever matches your setup.

### Option A: claude.ai (remote connector, no install)

1. In claude.ai, go to **Settings → Connectors → Add custom connector**.
2. **Name**: `NoPM`
3. **URL**: `https://stillnotbald.com/api/mcp`
4. **Authentication**: if the connector UI offers a plain header field, add a header `Authorization` with the value `Bearer npm_your_token_here` (use your real token from Step 2). Some client versions only offer OAuth-style auth and will not accept a static header. If that happens, use Option C below (`mcp-remote`) as a local bridge instead. Field names in claude.ai change from time to time; match them by meaning rather than by exact wording.

### Option B: Claude Desktop (local, custom connector)

Edit your Claude Desktop config file (on Windows: `%APPDATA%\Claude\claude_desktop_config.json`; on Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "nopm": {
      "command": "node",
      "args": ["/absolute/path/to/NoPM/web/mcp/server.mjs"],
      "env": {
        "NOPM_API_URL": "https://stillnotbald.com",
        "NOPM_TOKEN": "npm_your_token_here"
      }
    }
  }
}
```

This requires a local clone of the NoPM repository (the `server.mjs` file lives in `web/mcp/`). Replace the path with the real absolute path on your machine, and restart Claude Desktop.

### Option C: Claude Code (zero config, from a clone)

If you have cloned the NoPM repository, it already contains a `.mcp.json` file at its root. Set the environment variable `NOPM_TOKEN` to your token, then open the repo folder in Claude Code. The NoPM tools appear automatically, no editing required.

### Fallback bridge (if a client only supports OAuth)

```bash
npx mcp-remote https://stillnotbald.com/api/mcp --header "Authorization: Bearer npm_your_token_here"
```

Register this as a normal local MCP server the way you would in Option B.

## Step 4: Verify the connection

Ask Claude: *"List my NoPM projects."* If it's connected correctly, Claude will call the `list_projects` tool and show you real project data from the demo workspace, usually after a one-time tool-approval prompt in the client.

## Five things to ask Claude to do

Try these, roughly in order:

1. *"List my NoPM projects and tell me which ones are amber or red."*
2. *"Create a new task called 'Review Q3 numbers' in [pick a project] and mark it in progress."*
3. *"Show me the risks and issues open on that project."*
4. *"Request deletion of that task you just created, with a reason."* (Watch what happens next. See the box below.)
5. *"Pull the last 10 audit log entries for that project."*

## What you cannot do, and why

**Claude can request a deletion. Approving it takes a different person.** NoPM enforces "four-eyes" (maker-checker) governance: whoever asks for a task or project to be deleted cannot be the same person who approves it, and that rule is enforced by the database itself, not just by the app. A token counts as the person who minted it. The least-privilege agent token described in Step 2 is deliberately built without any approve, admin, or token-management scope, so even if you asked Claude to approve its own deletion request, it has no scope to do it with. Even a token that did hold an approve scope would be refused if you minted it, because it counts as you, the same person who raised the request.

This is not a UI restriction you could work around by clicking a different button. It is a rule the API and the database both enforce independently.

## What to look at afterwards: the Trust Center

Open **Trust Center** (`/trust`) in the browser. This is a live, append-only stream of every action taken in the workspace, including everything Claude just did. Each row shows who (or what) did it, what the action was, and when. Look for:

- A `task.create` row matching the task Claude created in step 2.
- A `deletion_request` row from step 4, sitting in a pending state (because nobody has approved it).
- A filter bar that lets you narrow the stream by channel: filter by `mcp` to see only the rows Claude's connection produced, versus rows from the CLI or the web UI.

This is the point of the whole exercise: nothing Claude did is invisible or silently reversible. Every write is one permanent row.

## A note on the demo itself

The demo workspace is shared with every other visitor and gets reseeded and wiped from time to time, so do not treat anything you create there as durable. It exists to be played with. There is no uptime guarantee on the hosted demo either; if it ever seems to be down, that is a known possibility of a free-tier hosting setup, not a sign anything is broken with NoPM itself. Never put real client data, real email addresses, or real payment details into the demo. If you want a private, stable instance, see [02-run-it-yourself.md](02-run-it-yourself.md).
