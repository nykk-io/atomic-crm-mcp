#!/usr/bin/env node
/**
 * Atomic CRM MCP Server
 *
 * Exposes Atomic CRM data as MCP tools so LLMs (Claude, etc.) can interact
 * with contacts, companies, deals, and more via natural language.
 *
 * Transport: stdio (runs as a subprocess of the MCP client).
 * Auth: see src/auth.ts for the full authentication strategy.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAuthenticatedClient } from "./auth.js";
import { runLogin } from "./login.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerCompanyTools } from "./tools/companies.js";
import { registerSalesTools } from "./tools/sales.js";
import { registerDealTools } from "./tools/deals.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerTagTools } from "./tools/tags.js";
import { registerConfigurationTools } from "./tools/configuration.js";
import { registerLoginTool } from "./tools/login.js";

async function main(): Promise<void> {
  // Subcommand dispatch: `atomic-crm-mcp login` runs the OAuth login flow.
  if (process.argv[2] === "login") {
    await runLogin();
    return;
  }

  const server = new McpServer({
    name: "atomic-crm-mcp-server",
    version: "0.1.0",
  });

  // Login tool is always available — it doesn't require an existing session.
  registerLoginTool(server);

  // Try to authenticate. If it fails, the server still starts with the login
  // tool so the LLM can initiate the OAuth flow from the conversation.
  let supabase;
  try {
    supabase = await createAuthenticatedClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[auth] Could not authenticate: ${msg}\n`);
    process.stderr.write("[auth] Server starting with login tool only. Use crm_login to authenticate.\n");
  }

  if (supabase) {
    // Register CRM tool groups (require an authenticated client).
    registerContactTools(server, supabase);
    registerCompanyTools(server, supabase);
    registerSalesTools(server, supabase);
    registerDealTools(server, supabase);
    registerNoteTools(server, supabase);
    registerAttachmentTools(server, supabase);
    registerTaskTools(server, supabase);
    registerTagTools(server, supabase);
    registerConfigurationTools(server, supabase);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr — stdout is reserved for the MCP JSON-RPC protocol.
  process.stderr.write("[mcp] Atomic CRM server ready\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp] Fatal error: ${message}\n`);
  process.exit(1);
});
