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

// ── Helper: build pagination metadata ───────────────────────────────────────

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

// ── Helper: truncate if too large ────────────────────────────────────────────

function toText(data: unknown): string {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    JSON.stringify({ error: "Response truncated", hint: "Use a smaller limit or add filters" }, null, 2)
  );
}

// ── Tool: crm_list_contacts ──────────────────────────────────────────────────

const ListContactsSchema = z.object({
  q: z
    .string()
    .optional()
    .describe(
      "Free-text search across first name, last name, company name, title, and email"
    ),
  company_id: z
    .number()
    .int()
    .optional()
    .describe("Filter contacts belonging to a specific company (by company ID)"),
  sales_id: z
    .number()
    .int()
    .optional()
    .describe("Filter contacts assigned to a specific sales person (by user ID)"),
  ...PaginationSchema,
});

// ── Tool: crm_get_contact ────────────────────────────────────────────────────

const GetContactSchema = z.object({
  id: z.number().int().describe("Numeric ID of the contact to retrieve"),
});

// ── Tool: crm_create_contact ─────────────────────────────────────────────────

const CreateContactSchema = z.object({
  first_name: z.string().min(1).describe("First name"),
  last_name: z.string().min(1).describe("Last name"),
  title: z.string().optional().describe("Job title (e.g. 'CEO', 'Sales Manager')"),
  email: z.string().email().optional().describe("Primary email address"),
  phone: z.string().optional().describe("Primary phone number"),
  company_id: z.number().int().optional().describe("ID of the company to associate this contact with"),
  gender: z.enum(["male", "female"]).optional().describe("Gender: 'male' or 'female'"),
  background: z.string().optional().describe("Free-text background / notes about the contact"),
  linkedin_url: z.string().url().optional().describe("LinkedIn profile URL (e.g. https://linkedin.com/in/username)"),
  sales_id: z.number().int().optional().describe("ID of the sales person assigned to this contact"),
});

// ── Tool: crm_update_contact ─────────────────────────────────────────────────

const UpdateContactSchema = z.object({
  id: z.number().int().describe("ID of the contact to update"),
  first_name: z.string().min(1).optional().describe("First name"),
  last_name: z.string().min(1).optional().describe("Last name"),
  title: z.string().optional().describe("Job title"),
  email: z.string().email().optional().describe("Primary email address (replaces existing Work email)"),
  phone: z.string().optional().describe("Primary phone number (replaces existing Work phone)"),
  company_id: z.number().int().nullable().optional().describe("Company ID to associate (null to remove association)"),
  gender: z.enum(["male", "female"]).optional().describe("Gender: 'male' or 'female'"),
  background: z.string().optional().describe("Free-text background / notes"),
  linkedin_url: z.string().url().optional().describe("LinkedIn profile URL"),
  sales_id: z.number().int().nullable().optional().describe("ID of the assigned sales person (null to unassign)"),
  tags: z.array(z.number().int()).optional().describe("Array of tag IDs to assign to this contact (replaces existing tags). Use crm_list_tags to find valid IDs."),
});

// ── Tool: crm_assign_contact_to_company ──────────────────────────────────────

const AssignContactToCompanySchema = z.object({
  contact_id: z.number().int().describe("ID of the contact to update"),
  company_id: z.number().int().describe("ID of the company to assign. Use crm_list_companies to find the right ID"),
});

// ── Register all contact tools ───────────────────────────────────────────────

export function registerContactTools(
  server: McpServer,
  client: SupabaseClient
): void {
  // ── crm_list_contacts ──────────────────────────────────────────────────────
  server.registerTool(
    "crm_list_contacts",
    {
      title: "List / Search Contacts",
      description: `Returns a paginated list of contacts from Atomic CRM.

Supports free-text search (q) across name, email, company, and title.
Can filter by company or by the assigned sales person.

Returns:
  {
    total: number,        // total matching records
    count: number,        // records in this page
    offset: number,       // current offset
    has_more: boolean,    // whether a next page exists
    next_offset?: number, // pass as offset for the next page
    data: Contact[]       // array of contact summaries
  }

Each Contact includes: id, first_name, last_name, title, company_name, email, phone, status.

Examples:
  - List all contacts:            { }
  - Search by name:               { q: "García" }
  - Filter by company:            { company_id: 42 }
  - Paginate:                     { limit: 10, offset: 10 }`,
      inputSchema: ListContactsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ q, company_id, sales_id, limit, offset }) => {
      try {
        let query = client
          .from("contacts_summary")
          .select("*", { count: "exact" })
          .range(offset, offset + limit - 1);

        if (q) {
          const tokens = q.trim().split(/\s+/);
          const searchFields = ["first_name", "last_name", "company_name", "title"];
          if (tokens.length === 1) {
            // Single word: OR across all fields
            query = query.or(
              searchFields.map((f) => `${f}.ilike.%${tokens[0]}%`).join(",")
            );
          } else {
            // Multiple words: each token must match at least one field (AND between tokens)
            // Uses PostgREST nested and(or(...),or(...)) syntax in a single .or() call
            const andGroups = tokens.map(
              (token) =>
                `or(${searchFields.map((f) => `${f}.ilike.%${token}%`).join(",")})`
            );
            query = query.or(`and(${andGroups.join(",")})`);
          }
        }
        if (company_id !== undefined) query = query.eq("company_id", company_id);
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
              text: `Error listing contacts: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_get_contact ────────────────────────────────────────────────────────
  server.registerTool(
    "crm_get_contact",
    {
      title: "Get Contact by ID",
      description: `Retrieves the full details of a contact, enriched with related data in a single call.

Returns:
  - All contact fields (id, first_name, last_name, title, company_id, company_name,
    email, phone, gender, background, status, has_newsletter, linkedin_url,
    sales_id, first_seen, last_seen, nb_tasks)
  - tags: resolved tag objects (id, name, color) — not just IDs
  - recent_deals: last 5 deals where this contact is involved
  - pending_tasks: all pending tasks (done_date IS NULL), ordered by due_date
  - recent_notes: last 5 notes, ordered by date descending

Returns an error if the contact does not exist.`,
      inputSchema: GetContactSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const { data: contact, error } = await client
          .from("contacts_summary")
          .select("*")
          .eq("id", id)
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Contact with ID ${id} not found. Use crm_list_contacts to find valid IDs.` }],
            };
          }
          throw new Error(error.message);
        }

        // Fetch related data in parallel
        const [tagsResult, dealsResult, tasksResult, notesResult] = await Promise.all([
          // Resolve tag IDs → tag objects
          contact.tags?.length
            ? client.from("tags").select("id, name, color").in("id", contact.tags)
            : Promise.resolve({ data: [], error: null }),
          // Last 5 deals involving this contact
          client.from("deals").select("id, name, stage, amount, expected_closing_date, company_id")
            .contains("contact_ids", [id])
            .order("updated_at", { ascending: false })
            .limit(5),
          // Pending tasks
          client.from("tasks").select("id, type, text, due_date, sales_id")
            .eq("contact_id", id)
            .is("done_date", null)
            .order("due_date", { ascending: true }),
          // Last 5 notes
          client.from("contact_notes").select("id, text, status, date, sales_id")
            .eq("contact_id", id)
            .order("date", { ascending: false })
            .limit(5),
        ]);

        const result = {
          ...contact,
          tags: tagsResult.data ?? [],
          recent_deals: dealsResult.data ?? [],
          pending_tasks: tasksResult.data ?? [],
          recent_notes: notesResult.data ?? [],
        };

        return { content: [{ type: "text" as const, text: toText(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error fetching contact ${id}: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  // ── crm_create_contact ─────────────────────────────────────────────────────
  server.registerTool(
    "crm_create_contact",
    {
      title: "Create Contact",
      description: `Creates a new contact in Atomic CRM.

Required: first_name, last_name.
All other fields are optional.

Email and phone are stored as the primary (Work) entry.
To associate with a company, pass company_id (use crm_list_companies to find it).

Returns the newly created contact record with its assigned ID.`,
      inputSchema: CreateContactSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ first_name, last_name, title, email, phone, company_id, gender, background, linkedin_url, sales_id }) => {
      try {
        const { data, error } = await client
          .from("contacts")
          .insert({
            first_name,
            last_name,
            title,
            company_id,
            gender,
            background,
            linkedin_url,
            sales_id,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
            email_jsonb: email ? [{ email, type: "Work" }] : [],
            phone_jsonb: phone ? [{ number: phone, type: "Work" }] : [],
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
              text: `Error creating contact: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_update_contact ─────────────────────────────────────────────────────
  server.registerTool(
    "crm_update_contact",
    {
      title: "Update Contact",
      description: `Updates one or more fields of an existing contact.

Only the fields you provide are changed — omitted fields are left untouched.

Updatable fields: first_name, last_name, title, email, phone,
company_id, gender, background, linkedin_url, sales_id, tags.

Pass company_id: null to remove the company association.
Pass sales_id: null to unassign the sales person.
Pass tags: [] to remove all tags, or an array of tag IDs (use crm_list_tags to find them).

Returns the updated contact record.`,
      inputSchema: UpdateContactSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, email, phone, ...rest }) => {
      try {
        // Build the patch with only defined fields
        const patch: Record<string, unknown> = {
          last_seen: new Date().toISOString(),
        };

        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) patch[key] = value;
        }

        if (email !== undefined) {
          patch.email_jsonb = email ? [{ email, type: "Work" }] : [];
        }
        if (phone !== undefined) {
          patch.phone_jsonb = phone ? [{ number: phone, type: "Work" }] : [];
        }

        const { data, error } = await client
          .from("contacts")
          .update(patch)
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Contact ${id} not found.` }],
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
              text: `Error updating contact ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_assign_contact_to_company ──────────────────────────────────────────
  server.registerTool(
    "crm_assign_contact_to_company",
    {
      title: "Assign Contact to Company",
      description: `Links an existing contact to a company.

Use crm_list_companies to find the company_id if you only know the name.
Overwrites any previous company association.

Returns the updated contact record.`,
      inputSchema: AssignContactToCompanySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ contact_id, company_id }) => {
      try {
        const { data, error } = await client
          .from("contacts")
          .update({ company_id, last_seen: new Date().toISOString() })
          .eq("id", contact_id)
          .select()
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Contact ${contact_id} not found.` }],
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
              text: `Error assigning contact ${contact_id} to company ${company_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
