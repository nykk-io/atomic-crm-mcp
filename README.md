# 🤝 @nykk/atomic-crm-mcp

An MCP server for [Atomic CRM](https://github.com/marmelab/atomic-crm) — a fantastic open-source CRM built by the folks at [Marmelab](https://marmelab.com). Huge thanks to them for building and open-sourcing it.

This package lets you talk to your Atomic CRM instance through natural language — manage contacts, companies, deals, notes, tasks, and file attachments — from Claude Code, Claude Desktop, or any MCP-compatible client.

Built with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [Supabase](https://supabase.com).

> **Heads up:** this project is roughly **95% vibe-coded**. It works for my use case, but it hasn't been battle-tested. Expect rough edges, and please don't rely on it for anything critical without giving it a good look first.

---

## This is not a replacement for the official MCP

Marmelab already published their own MCP server: [marmelab/atomic-crm-mcp](https://github.com/marmelab/atomic-crm-mcp). It's the official one — go check it out.

This project is just a different approach. Where their server exposes two generic tools (`get_schema` + `query`) that let the LLM write raw SQL, this one exposes ~30 domain-specific tools (one per entity and action).

Neither approach is strictly better — it depends on what you need. This one trades flexibility for simplicity: the LLM doesn't need to know SQL, and each call only passes the fields that are actually relevant.

---

## 🚀 Quick start (Claude Code)

Pick the authentication method that fits your setup:

**Option A — Email + password** (recommended for personal use):

```bash
claude mcp add atomic-crm \
  -e SUPABASE_URL="https://your-crm.example.com" \
  -e SUPABASE_ANON_KEY="your-anon-key" \
  -e SUPABASE_EMAIL="you@example.com" \
  -e SUPABASE_PASSWORD="yourpassword" \
  -- npx -y @nykk/atomic-crm-mcp
```

**Option B — Service role key** (admin access, no user login needed):

```bash
claude mcp add atomic-crm \
  -e SUPABASE_URL="https://your-crm.example.com" \
  -e SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" \
  -- npx -y @nykk/atomic-crm-mcp
```

**Option C — OAuth / SSO provider**:

> **Note:** the OAuth login flow has only been tested with **Keycloak**. It might work with other providers (Authelia, Google, GitHub…) since it uses standard PKCE, but I haven't verified it personally. Proceed with caution and let me know if it works for you.

First run the one-time login command — it opens a browser, authenticates, and saves the session locally:

```bash
SUPABASE_URL="https://your-crm.example.com" \
SUPABASE_ANON_KEY="your-anon-key" \
SUPABASE_OAUTH_PROVIDER="keycloak" \
  npx -y @nykk/atomic-crm-mcp login
```

Then register the server (no credentials in the config — the saved session is reused automatically):

```bash
claude mcp add atomic-crm \
  -e SUPABASE_URL="https://your-crm.example.com" \
  -e SUPABASE_ANON_KEY="your-anon-key" \
  -- npx -y @nykk/atomic-crm-mcp
```

> **OAuth callback URL**: the login command starts a local server on `http://localhost:54321/callback`.
> You must add this URL to the **Additional Redirect URLs** list in your Supabase project
> (**Authentication → URL Configuration**) before running `login`.

---

## 🧰 Available tools (30)

### Contacts
| Tool | Description |
|---|---|
| `crm_list_contacts` | List and search contacts with pagination and filtering |
| `crm_get_contact` | Get a contact enriched with tags, recent deals, pending tasks, and recent notes |
| `crm_create_contact` | Create a new contact |
| `crm_update_contact` | Update contact fields, including tag assignment |
| `crm_assign_contact_to_company` | Link a contact to a company |

### Companies
| Tool | Description |
|---|---|
| `crm_list_companies` | List and search companies with pagination and filtering |
| `crm_get_company` | Get full details of a company by ID |
| `crm_create_company` | Create a new company |
| `crm_update_company` | Update company fields |

### Deals
| Tool | Description |
|---|---|
| `crm_list_deals` | List and search deals, filter by stage, company, or sales person |
| `crm_get_deal` | Get a deal enriched with company info, associated contacts, and recent notes |
| `crm_create_deal` | Create a new deal |
| `crm_update_deal` | Update deal fields (stage, amount, closing date, archive…) |

### Notes
| Tool | Description |
|---|---|
| `crm_list_contact_notes` | List all notes for a contact |
| `crm_create_contact_note` | Add a note to a contact |
| `crm_update_contact_note` | Edit a contact note |
| `crm_delete_contact_note` | Delete a contact note |
| `crm_list_deal_notes` | List all notes for a deal |
| `crm_create_deal_note` | Add a note to a deal |
| `crm_update_deal_note` | Edit a deal note |
| `crm_delete_deal_note` | Delete a deal note |

### Tasks
| Tool | Description |
|---|---|
| `crm_list_tasks` | List tasks, filter by contact or sales person (pending only by default) |
| `crm_create_task` | Create a task linked to a contact |
| `crm_complete_task` | Mark a task as completed |
| `crm_delete_task` | Delete a task |

### Tags
| Tool | Description |
|---|---|
| `crm_list_tags` | List all available tags (id, name, color) |

### Attachments
| Tool | Description |
|---|---|
| `crm_upload_attachment` | Upload a file (base64, max ~7.5 MB) to a note and store it in Supabase Storage |
| `crm_download_attachment` | Download a file from a note (images returned inline, others as base64) |
| `crm_delete_attachment` | Remove a file from a note and delete it from storage |

### Sales
| Tool | Description |
|---|---|
| `crm_list_sales` | List sales team members (use to find `sales_id`) |

---

## ⚙️ Environment variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | **Always** | Your Atomic CRM URL (e.g. `https://crm.example.com`) |
| `SUPABASE_ANON_KEY` | Auth options A & C | Supabase anon/publishable key (safe to share) |
| `SUPABASE_EMAIL` | Auth option A | User email for non-interactive login |
| `SUPABASE_PASSWORD` | Auth option A | User password for non-interactive login |
| `SUPABASE_SERVICE_ROLE_KEY` | Auth option B | Service role key — skips user auth, grants admin access |
| `SUPABASE_OAUTH_PROVIDER` | Auth option C (`login` only) | OAuth provider slug as configured in Supabase (e.g. `keycloak`) |

> Where to find these values: in your Supabase project dashboard under **Settings → API**.

---

## 🔐 Authentication

Three authentication strategies are supported. The server tries them in order — the first one that works is used:

| Priority | Method | How to configure |
|---|---|---|
| 1 | **Service role key** | Set `SUPABASE_SERVICE_ROLE_KEY`. Admin access, no user login needed. Good for automation. |
| 2 | **Email + password** | Set `SUPABASE_EMAIL` + `SUPABASE_PASSWORD`. Non-interactive, credentials stay in the MCP config. |
| 3 | **Saved session** | Reuses the refresh token from a previous `login` run. Auto-refreshed on every start. |
| 4 | **Interactive login** | Fallback: prompts email + password via stderr on first run, then saves the session. |

### OAuth / SSO login (`login` subcommand)

For SSO providers, use the `login` subcommand once to authenticate via the browser. It implements the OAuth 2.0 PKCE flow and saves a session to `~/.config/atomic-crm-mcp/session.json`.

```bash
SUPABASE_URL="https://your-crm.example.com" \
SUPABASE_ANON_KEY="your-anon-key" \
SUPABASE_OAUTH_PROVIDER="keycloak" \
  npx @nykk/atomic-crm-mcp login
```

Requirements:
- `SUPABASE_OAUTH_PROVIDER` must match the provider slug configured in Supabase.
- `http://localhost:54321/callback` must be listed in **Authentication → URL Configuration → Additional Redirect URLs** in your Supabase project.

After a successful login the saved session is reused automatically on every subsequent MCP start and refreshed on each run, so you only need to run `login` once (or again when the refresh token expires).

---

## Claude Desktop config

Add to `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**Email + password:**

```json
{
  "mcpServers": {
    "atomic-crm": {
      "command": "npx",
      "args": ["-y", "@nykk/atomic-crm-mcp"],
      "env": {
        "SUPABASE_URL": "https://your-crm.example.com",
        "SUPABASE_ANON_KEY": "your-anon-key",
        "SUPABASE_EMAIL": "you@example.com",
        "SUPABASE_PASSWORD": "yourpassword"
      }
    }
  }
}
```

**Service role key:**

```json
{
  "mcpServers": {
    "atomic-crm": {
      "command": "npx",
      "args": ["-y", "@nykk/atomic-crm-mcp"],
      "env": {
        "SUPABASE_URL": "https://your-crm.example.com",
        "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key"
      }
    }
  }
}
```

**OAuth / SSO** (after running `npx @nykk/atomic-crm-mcp login` once):

```json
{
  "mcpServers": {
    "atomic-crm": {
      "command": "npx",
      "args": ["-y", "@nykk/atomic-crm-mcp"],
      "env": {
        "SUPABASE_URL": "https://your-crm.example.com",
        "SUPABASE_ANON_KEY": "your-anon-key"
      }
    }
  }
}
```

---

## 🛠️ Development

```bash
git clone https://github.com/nykk-io/atomic-crm-mcp
cd atomic-crm-mcp
npm install
```

### Run in watch mode

```bash
SUPABASE_URL=https://crm.example.com \
SUPABASE_ANON_KEY=your-anon-key \
SUPABASE_SERVICE_ROLE_KEY=your-key \
  npm run dev
```

### Inspect with MCP Inspector (browser UI at http://localhost:5173)

```bash
SUPABASE_URL=https://crm.example.com \
SUPABASE_ANON_KEY=your-anon-key \
SUPABASE_SERVICE_ROLE_KEY=your-key \
  npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

### Test with raw JSON-RPC

```bash
# List all registered tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
    npx tsx src/index.ts 2>/dev/null
```

> `2>/dev/null` silences auth log messages (they go to stderr).
