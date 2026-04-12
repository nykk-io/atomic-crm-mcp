import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";

// ── Shared pagination schema ─────────────────────────────────────────────────

const PaginationSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Maximum number of results to return (1–100, default 25)"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip, for pagination (default 0)"),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function paginationMeta(total: number, offset: number, count: number) {
  const hasMore = total > offset + count;
  return {
    total,
    count,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + count } : {}),
  };
}

function toText(data: unknown): string {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= CHARACTER_LIMIT) return text;
  return JSON.stringify(
    { error: "Response truncated", hint: "Use a smaller limit or add filters" },
    null,
    2
  );
}

// ── Input schemas ─────────────────────────────────────────────────────────────

const ListDealsSchema = z.object({
  q: z
    .string()
    .optional()
    .describe("Free-text search across deal name, stage, category, and description"),
  company_id: z
    .number()
    .int()
    .optional()
    .describe("Filter deals belonging to a specific company (by company ID)"),
  stage: z
    .string()
    .optional()
    .describe(
      "Filter by pipeline stage (e.g. 'opportunity', 'proposal-sent', 'in-negociation', 'won', 'lost', 'delayed')"
    ),
  sales_id: z
    .number()
    .int()
    .optional()
    .describe("Filter deals assigned to a specific sales person (by user ID)"),
  ...PaginationSchema,
});

const GetDealSchema = z.object({
  id: z.number().int().describe("Numeric ID of the deal to retrieve"),
});

const CreateDealSchema = z.object({
  name: z.string().min(1).describe("Deal name"),
  stage: z
    .string()
    .describe(
      "Pipeline stage (e.g. 'opportunity', 'proposal-sent', 'in-negociation', 'won', 'lost', 'delayed')"
    ),
  company_id: z
    .number()
    .int()
    .optional()
    .describe("ID of the company this deal belongs to"),
  contact_ids: z
    .array(z.number().int())
    .optional()
    .describe("Array of contact IDs to associate with this deal"),
  amount: z
    .number()
    .int()
    .min(0)
    .describe("Deal budget/value (integer, in the configured currency). Use 0 if unknown."),
  category: z.string().optional().describe("Deal category"),
  description: z.string().optional().describe("Deal description"),
  expected_closing_date: z
    .string()
    .optional()
    .describe("Expected closing date (ISO date: YYYY-MM-DD)"),
  sales_id: z
    .number()
    .int()
    .optional()
    .describe("ID of the sales person assigned to this deal"),
});

const UpdateDealSchema = z.object({
  id: z.number().int().describe("ID of the deal to update"),
  name: z.string().min(1).optional().describe("Deal name"),
  stage: z.string().optional().describe("Pipeline stage"),
  amount: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Deal value (null to clear)"),
  category: z.string().nullable().optional().describe("Deal category (null to clear)"),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("Deal description (null to clear)"),
  expected_closing_date: z
    .string()
    .nullable()
    .optional()
    .describe("Expected closing date as YYYY-MM-DD (null to clear)"),
  sales_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Assigned sales person ID (null to unassign)"),
  company_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Company ID (null to remove association)"),
  contact_ids: z
    .array(z.number().int())
    .optional()
    .describe("Array of contact IDs (replaces existing list)"),
  archived_at: z
    .string()
    .nullable()
    .optional()
    .describe("ISO 8601 timestamp to archive the deal, or null to unarchive"),
});

// ── Register all deal tools ───────────────────────────────────────────────────

export function registerDealTools(
  server: McpServer,
  client: SupabaseClient
): void {
  // ── crm_list_deals ───────────────────────────────────────────────────────────
  server.registerTool(
    "crm_list_deals",
    {
      title: "List / Search Deals",
      description: `Returns a paginated list of deals from Atomic CRM.

Supports free-text search (q) across name, stage, category, and description.
Can filter by company, pipeline stage, or assigned sales person.

Returns:
  {
    total: number,        // total matching records
    count: number,        // records in this page
    offset: number,       // current offset
    has_more: boolean,
    next_offset?: number,
    data: Deal[]
  }

Each Deal includes: id, name, stage, amount, company_id, contact_ids,
  category, description, expected_closing_date, sales_id, created_at, updated_at, archived_at.

Examples:
  - All open deals:           { }
  - Search by name:           { q: "Acme renewal" }
  - Filter by company:        { company_id: 12 }
  - Filter by stage:          { stage: "won" }
  - Paginate:                 { limit: 10, offset: 20 }`,
      inputSchema: ListDealsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ q, company_id, stage, sales_id, limit, offset }) => {
      try {
        let query = client
          .from("deals")
          .select("*", { count: "exact" })
          .range(offset, offset + limit - 1)
          .order("created_at", { ascending: false });

        if (q) {
          const tokens = q.trim().split(/\s+/);
          const searchFields = ["name", "stage", "category", "description"];
          if (tokens.length === 1) {
            query = query.or(
              searchFields.map((f) => `${f}.ilike.%${tokens[0]}%`).join(",")
            );
          } else {
            const andGroups = tokens.map(
              (token) =>
                `or(${searchFields.map((f) => `${f}.ilike.%${token}%`).join(",")})`
            );
            query = query.or(`and(${andGroups.join(",")})`);
          }
        }

        if (company_id !== undefined) query = query.eq("company_id", company_id);
        if (stage !== undefined) query = query.eq("stage", stage);
        if (sales_id !== undefined) query = query.eq("sales_id", sales_id);

        const { data, error, count } = await query;
        if (error) throw new Error(error.message);

        const result = {
          ...paginationMeta(count ?? 0, offset, data?.length ?? 0),
          data: data ?? [],
        };

        return { content: [{ type: "text" as const, text: toText(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error listing deals: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_get_deal ─────────────────────────────────────────────────────────────
  server.registerTool(
    "crm_get_deal",
    {
      title: "Get Deal by ID",
      description: `Retrieves full details of a deal, enriched with related data in a single call.

Returns:
  - All deal fields (id, name, stage, amount, category, description,
    expected_closing_date, sales_id, created_at, updated_at, archived_at)
  - company: company name and basic info (resolved from company_id)
  - contacts: basic info for all associated contacts (first_name, last_name, title, email)
  - recent_notes: last 5 deal notes, ordered by date descending

Returns an error if the deal does not exist.`,
      inputSchema: GetDealSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const { data: deal, error } = await client
          .from("deals")
          .select("*")
          .eq("id", id)
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Deal with ID ${id} not found. Use crm_list_deals to find valid IDs.` }],
            };
          }
          throw new Error(error.message);
        }

        // Fetch related data in parallel
        const [companyResult, contactsResult, notesResult] = await Promise.all([
          // Resolve company
          deal.company_id
            ? client.from("companies").select("id, name, sector, website").eq("id", deal.company_id).single()
            : Promise.resolve({ data: null, error: null }),
          // Resolve associated contacts — use contacts_summary for consistent field naming
          deal.contact_ids?.length
            ? client.from("contacts_summary").select("id, first_name, last_name, title, company_name")
                .in("id", deal.contact_ids)
            : Promise.resolve({ data: [], error: null }),
          // Last 5 notes
          client.from("deal_notes").select("id, type, text, date, sales_id")
            .eq("deal_id", id)
            .order("date", { ascending: false })
            .limit(5),
        ]);

        const result = {
          ...deal,
          company: companyResult.data ?? null,
          contacts: contactsResult.data ?? [],
          recent_notes: notesResult.data ?? [],
        };

        return { content: [{ type: "text" as const, text: toText(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error fetching deal ${id}: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  // ── crm_create_deal ──────────────────────────────────────────────────────────
  server.registerTool(
    "crm_create_deal",
    {
      title: "Create Deal",
      description: `Creates a new deal in Atomic CRM.

Required: name, stage, amount (use 0 if unknown).
All other fields are optional.

Use crm_list_companies to find a company_id.
Use crm_list_contacts to find contact_ids.

Returns the newly created deal record with its assigned ID.`,
      inputSchema: CreateDealSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, stage, company_id, contact_ids, amount, category, description, expected_closing_date, sales_id }) => {
      try {
        const { data, error } = await client
          .from("deals")
          .insert({
            name,
            stage,
            company_id,
            contact_ids: contact_ids ?? [],
            amount,
            category,
            description,
            expected_closing_date,
            sales_id,
          })
          .select()
          .single();

        if (error) throw new Error(error.message);
        return { content: [{ type: "text" as const, text: toText(data) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error creating deal: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_update_deal ──────────────────────────────────────────────────────────
  server.registerTool(
    "crm_update_deal",
    {
      title: "Update Deal",
      description: `Updates one or more fields of an existing deal.

Only the fields you provide are changed — omitted fields are left untouched.

Updatable fields: name, stage, amount, category, description,
  expected_closing_date, sales_id, company_id, contact_ids, archived_at.

Pass amount: null to clear the value.
Pass archived_at: null to unarchive a deal.

Returns the updated deal record.`,
      inputSchema: UpdateDealSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, ...rest }) => {
      try {
        const patch: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) patch[key] = value;
        }

        const { data, error } = await client
          .from("deals")
          .update(patch)
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Deal ${id} not found.` }],
            };
          }
          throw new Error(error.message);
        }

        return { content: [{ type: "text" as const, text: toText(data) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error updating deal ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
