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

const ListContactNotesSchema = z.object({
  contact_id: z
    .number()
    .int()
    .describe("ID of the contact whose notes to retrieve"),
  ...PaginationSchema,
});

const CreateContactNoteSchema = z.object({
  contact_id: z.number().int().describe("ID of the contact to add a note to"),
  text: z.string().min(1).describe("Note content"),
  status: z
    .string()
    .optional()
    .describe("Note status (e.g. 'cold', 'warm', 'hot', 'in-contract')"),
  date: z
    .string()
    .optional()
    .describe("Note date as ISO 8601 timestamp (defaults to now)"),
  sales_id: z
    .number()
    .int()
    .optional()
    .describe("ID of the sales person authoring this note"),
});

const UpdateContactNoteSchema = z.object({
  id: z.number().int().describe("ID of the contact note to update"),
  text: z.string().min(1).optional().describe("Updated note content"),
  status: z.string().nullable().optional().describe("Updated status (null to clear)"),
});

const DeleteContactNoteSchema = z.object({
  id: z.number().int().describe("ID of the contact note to delete"),
});

const ListDealNotesSchema = z.object({
  deal_id: z.number().int().describe("ID of the deal whose notes to retrieve"),
  ...PaginationSchema,
});

const CreateDealNoteSchema = z.object({
  deal_id: z.number().int().describe("ID of the deal to add a note to"),
  text: z.string().min(1).describe("Note content"),
  type: z
    .string()
    .optional()
    .describe("Note type (e.g. 'Email', 'Call', 'Meeting', 'Other')"),
  date: z
    .string()
    .optional()
    .describe("Note date as ISO 8601 timestamp (defaults to now)"),
  sales_id: z
    .number()
    .int()
    .optional()
    .describe("ID of the sales person authoring this note"),
});

const UpdateDealNoteSchema = z.object({
  id: z.number().int().describe("ID of the deal note to update"),
  text: z.string().min(1).optional().describe("Updated note content"),
  type: z.string().nullable().optional().describe("Updated note type (null to clear)"),
});

const DeleteDealNoteSchema = z.object({
  id: z.number().int().describe("ID of the deal note to delete"),
});

// ── Register all note tools ───────────────────────────────────────────────────

export function registerNoteTools(
  server: McpServer,
  client: SupabaseClient
): void {
  // ── crm_list_contact_notes ───────────────────────────────────────────────────
  server.registerTool(
    "crm_list_contact_notes",
    {
      title: "List Contact Notes",
      description: `Returns all notes for a specific contact, ordered by date descending.

Each note includes: id, contact_id, text, status, date, sales_id, attachments.

Returns:
  {
    total: number,
    count: number,
    offset: number,
    has_more: boolean,
    next_offset?: number,
    data: ContactNote[]
  }`,
      inputSchema: ListContactNotesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ contact_id, limit, offset }) => {
      try {
        const { data, error, count } = await client
          .from("contact_notes")
          .select("*", { count: "exact" })
          .eq("contact_id", contact_id)
          .order("date", { ascending: false })
          .range(offset, offset + limit - 1);

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
              text: `Error listing notes for contact ${contact_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_create_contact_note ──────────────────────────────────────────────────
  server.registerTool(
    "crm_create_contact_note",
    {
      title: "Create Contact Note",
      description: `Adds a new note to a contact.

Required: contact_id, text.
Optional: status, date, sales_id.

Common statuses: 'cold', 'warm', 'hot', 'in-contract'.
Date defaults to now if not provided.

Returns the newly created note record.`,
      inputSchema: CreateContactNoteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ contact_id, text, status, date, sales_id }) => {
      try {
        const { data, error } = await client
          .from("contact_notes")
          .insert({
            contact_id,
            text,
            status,
            date: date ?? new Date().toISOString(),
            sales_id,
            attachments: [],
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
              text: `Error creating contact note: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_update_contact_note ──────────────────────────────────────────────────
  server.registerTool(
    "crm_update_contact_note",
    {
      title: "Update Contact Note",
      description: `Updates the text or status of an existing contact note.

Only provided fields are changed. Omitted fields are left untouched.
Pass status: null to clear the status.

Returns the updated note record.`,
      inputSchema: UpdateContactNoteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, text, status }) => {
      try {
        const patch: Record<string, unknown> = {};
        if (text !== undefined) patch.text = text;
        if (status !== undefined) patch.status = status;

        const { data, error } = await client
          .from("contact_notes")
          .update(patch)
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Contact note ${id} not found.` }],
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
              text: `Error updating contact note ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_delete_contact_note ──────────────────────────────────────────────────
  server.registerTool(
    "crm_delete_contact_note",
    {
      title: "Delete Contact Note",
      description: `Permanently deletes a contact note by ID.

WARNING: This action is irreversible. Any file attachments stored in Supabase
Storage for this note will be cleaned up automatically by a database trigger.

Returns a confirmation message on success.`,
      inputSchema: DeleteContactNoteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const { error } = await client
          .from("contact_notes")
          .delete()
          .eq("id", id);

        if (error) throw new Error(error.message);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, deleted_id: id }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error deleting contact note ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_list_deal_notes ──────────────────────────────────────────────────────
  server.registerTool(
    "crm_list_deal_notes",
    {
      title: "List Deal Notes",
      description: `Returns all notes for a specific deal, ordered by date descending.

Each note includes: id, deal_id, type, text, date, sales_id, attachments.

Returns:
  {
    total: number,
    count: number,
    offset: number,
    has_more: boolean,
    next_offset?: number,
    data: DealNote[]
  }`,
      inputSchema: ListDealNotesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deal_id, limit, offset }) => {
      try {
        const { data, error, count } = await client
          .from("deal_notes")
          .select("*", { count: "exact" })
          .eq("deal_id", deal_id)
          .order("date", { ascending: false })
          .range(offset, offset + limit - 1);

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
              text: `Error listing notes for deal ${deal_id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_create_deal_note ─────────────────────────────────────────────────────
  server.registerTool(
    "crm_create_deal_note",
    {
      title: "Create Deal Note",
      description: `Adds a new note to a deal.

Required: deal_id, text.
Optional: type, date, sales_id.

Common types: 'Email', 'Call', 'Meeting', 'Other'.
Date defaults to now if not provided.

Returns the newly created note record.`,
      inputSchema: CreateDealNoteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ deal_id, text, type, date, sales_id }) => {
      try {
        const { data, error } = await client
          .from("deal_notes")
          .insert({
            deal_id,
            text,
            type,
            date: date ?? new Date().toISOString(),
            sales_id,
            attachments: [],
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
              text: `Error creating deal note: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_update_deal_note ─────────────────────────────────────────────────────
  server.registerTool(
    "crm_update_deal_note",
    {
      title: "Update Deal Note",
      description: `Updates the text or type of an existing deal note.

Only provided fields are changed. Omitted fields are left untouched.
Pass type: null to clear the type.

Returns the updated note record.`,
      inputSchema: UpdateDealNoteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, text, type }) => {
      try {
        const patch: Record<string, unknown> = {};
        if (text !== undefined) patch.text = text;
        if (type !== undefined) patch.type = type;

        const { data, error } = await client
          .from("deal_notes")
          .update(patch)
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Deal note ${id} not found.` }],
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
              text: `Error updating deal note ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_delete_deal_note ─────────────────────────────────────────────────────
  server.registerTool(
    "crm_delete_deal_note",
    {
      title: "Delete Deal Note",
      description: `Permanently deletes a deal note by ID.

WARNING: This action is irreversible. Any file attachments stored in Supabase
Storage for this note will be cleaned up automatically by a database trigger.

Returns a confirmation message on success.`,
      inputSchema: DeleteDealNoteSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const { error } = await client
          .from("deal_notes")
          .delete()
          .eq("id", id);

        if (error) throw new Error(error.message);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, deleted_id: id }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error deleting deal note ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
