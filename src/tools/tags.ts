import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export function registerTagTools(server: McpServer, client: SupabaseClient): void {

  // ── crm_list_tags ────────────────────────────────────────────────────────────
  server.registerTool(
    "crm_list_tags",
    {
      title: "List Tags",
      description: `Returns all available tags in Atomic CRM.

Each tag includes: id, name, color (hex string).

Use the tag IDs when assigning tags to a contact via crm_update_contact.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const { data, error } = await client
          .from("tags")
          .select("*")
          .order("name", { ascending: true });

        if (error) throw new Error(error.message);
        return { content: [{ type: "text" as const, text: JSON.stringify(data ?? [], null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `Error listing tags: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );
}
