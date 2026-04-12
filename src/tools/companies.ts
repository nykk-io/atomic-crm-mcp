import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";

// ── Helpers (same pattern as contacts.ts) ────────────────────────────────────

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

// ── Schemas ──────────────────────────────────────────────────────────────────

const ListCompaniesSchema = z.object({
  q: z
    .string()
    .optional()
    .describe("Free-text search across company name, website, and city"),
  sector: z
    .string()
    .optional()
    .describe("Filter by sector (exact match, e.g. 'Technology', 'Finance')"),
  sales_id: z
    .number()
    .int()
    .optional()
    .describe("Filter companies assigned to a specific sales person (by user ID)"),
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
});

const GetCompanySchema = z.object({
  id: z.number().int().describe("Numeric ID of the company to retrieve"),
});

const CreateCompanySchema = z.object({
  name: z.string().min(1).describe("Company name"),
  sector: z.string().optional().describe("Industry sector (e.g. 'Technology', 'Finance', 'Healthcare')"),
  size: z
    .number()
    .int()
    .optional()
    .describe("Approximate employee count. Use one of: 1, 10, 50, 250, 500"),
  website: z.string().url().optional().describe("Company website URL"),
  phone_number: z.string().optional().describe("Main phone number"),
  address: z.string().optional().describe("Street address"),
  city: z.string().optional().describe("City"),
  zipcode: z.string().optional().describe("Zip / postal code"),
  state_abbr: z.string().optional().describe("State or province abbreviation (e.g. 'CA', 'NY')"),
  country: z.string().optional().describe("Country name"),
  description: z.string().optional().describe("Free-text description or notes about the company"),
  sales_id: z.number().int().optional().describe("ID of the sales person assigned to this company (use crm_list_sales to find it)"),
});

const UpdateCompanySchema = z.object({
  id: z.number().int().describe("ID of the company to update"),
  name: z.string().min(1).optional().describe("Company name"),
  sector: z.string().optional().describe("Industry sector (e.g. 'Technology', 'Finance')"),
  size: z.number().int().optional().describe("Approximate employee count. Use one of: 1, 10, 50, 250, 500"),
  website: z.string().url().optional().describe("Company website URL"),
  phone_number: z.string().optional().describe("Main phone number"),
  address: z.string().optional().describe("Street address"),
  city: z.string().optional().describe("City"),
  zipcode: z.string().optional().describe("Zip / postal code"),
  state_abbr: z.string().optional().describe("State or province abbreviation (e.g. 'CA', 'NY')"),
  country: z.string().optional().describe("Country name"),
  description: z.string().optional().describe("Free-text description or notes"),
  sales_id: z.number().int().nullable().optional().describe("ID of the assigned sales person (null to unassign)"),
});

// ── Register ─────────────────────────────────────────────────────────────────

export function registerCompanyTools(
  server: McpServer,
  client: SupabaseClient
): void {
  // ── crm_list_companies ─────────────────────────────────────────────────────
  server.registerTool(
    "crm_list_companies",
    {
      title: "List / Search Companies",
      description: `Returns a paginated list of companies from Atomic CRM.

Supports free-text search (q) across name, website, and city.
Can filter by sector or by the assigned sales person.

Returns:
  {
    total: number,
    count: number,
    offset: number,
    has_more: boolean,
    next_offset?: number,
    data: Company[]
  }

Each Company includes: id, name, sector, size, website, phone_number,
address, city, zipcode, state_abbr, country, nb_contacts, nb_deals.

Examples:
  - List all:               { }
  - Search by name:         { q: "Acme" }
  - Filter by sector:       { sector: "Technology" }
  - Paginate:               { limit: 10, offset: 10 }`,
      inputSchema: ListCompaniesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ q, sector, sales_id, limit, offset }) => {
      try {
        let query = client
          .from("companies_summary")
          .select("*", { count: "exact" })
          .range(offset, offset + limit - 1);

        if (q) {
          const tokens = q.trim().split(/\s+/);
          const searchFields = ["name", "website", "city"];
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
        if (sector !== undefined) query = query.eq("sector", sector);
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
              text: `Error listing companies: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_get_company ────────────────────────────────────────────────────────
  server.registerTool(
    "crm_get_company",
    {
      title: "Get Company by ID",
      description: `Retrieves full details of a single company by its numeric ID.

Returns all available fields from the companies_summary view, including:
  id, name, sector, size, website, phone_number, address, city,
  zipcode, state_abbr, country, description, sales_id, nb_contacts, nb_deals.

Returns an error if the company does not exist.`,
      inputSchema: GetCompanySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const { data, error } = await client
          .from("companies_summary")
          .select("*")
          .eq("id", id)
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Company with ID ${id} not found. Use crm_list_companies to find valid IDs.`,
                },
              ],
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
              text: `Error fetching company ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_create_company ─────────────────────────────────────────────────────
  server.registerTool(
    "crm_create_company",
    {
      title: "Create Company",
      description: `Creates a new company in Atomic CRM.

Required: name.
All other fields are optional.

For size, use one of the standard buckets: 1, 10, 50, 250, 500.
Use crm_list_sales to find a valid sales_id to assign.

Returns the newly created company record with its assigned ID.`,
      inputSchema: CreateCompanySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (fields) => {
      try {
        const { data, error } = await client
          .from("companies")
          .insert({ ...fields, created_at: new Date().toISOString() })
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
              text: `Error creating company: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_update_company ─────────────────────────────────────────────────────
  server.registerTool(
    "crm_update_company",
    {
      title: "Update Company",
      description: `Updates one or more fields of an existing company.

Only the fields you provide are changed — omitted fields are left untouched.

Updatable fields: name, sector, size, website, phone_number, address,
city, zipcode, state_abbr, country, description, sales_id.

Pass sales_id: null to unassign the sales person.

Returns the updated company record.`,
      inputSchema: UpdateCompanySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, ...rest }) => {
      try {
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) patch[key] = value;
        }

        const { data, error } = await client
          .from("companies")
          .update(patch)
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Company ${id} not found.` }],
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
              text: `Error updating company ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
