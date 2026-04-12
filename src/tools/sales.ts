import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

function toText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

const ListSalesSchema = z.object({
  disabled: z
    .boolean()
    .optional()
    .describe("Filter by active/disabled status. Omit to return all users"),
});

export function registerSalesTools(
  server: McpServer,
  client: SupabaseClient
): void {
  server.registerTool(
    "crm_list_sales",
    {
      title: "List Sales Users",
      description: `Returns all sales team members.

Use this to find the sales_id needed when creating or updating contacts, companies, or deals.

Returns an array of users with fields:
  id            — use this as sales_id in other tools
  first_name
  last_name
  email
  administrator — true if the user has admin privileges
  disabled      — true if the account is deactivated

Examples:
  - All active users:   { disabled: false }
  - All users:          { }`,
      inputSchema: ListSalesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ disabled }) => {
      try {
        let query = client
          .from("sales")
          .select("id, first_name, last_name, email, administrator, disabled")
          .order("last_name");

        if (disabled !== undefined) query = query.eq("disabled", disabled);

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        return { content: [{ type: "text" as const, text: toText(data) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error listing sales users: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
