import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PaginationSchema = {
  limit: z.number().int().min(1).max(100).default(25).describe("Maximum results (1–100, default 25)"),
  offset: z.number().int().min(0).default(0).describe("Results to skip for pagination (default 0)"),
};

function paginationMeta(total: number, offset: number, count: number) {
  const hasMore = total > offset + count;
  return { total, count, offset, has_more: hasMore, ...(hasMore ? { next_offset: offset + count } : {}) };
}

function toText(data: unknown): string {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= CHARACTER_LIMIT) return text;
  return JSON.stringify({ error: "Response truncated", hint: "Use a smaller limit or add filters" }, null, 2);
}

// ── Input schemas ─────────────────────────────────────────────────────────────

const ListTasksSchema = z.object({
  contact_id: z.number().int().optional().describe("Filter tasks for a specific contact"),
  sales_id: z.number().int().optional().describe("Filter tasks assigned to a specific sales person"),
  pending_only: z.boolean().default(true).describe("If true (default), return only pending tasks (done_date IS NULL)"),
  ...PaginationSchema,
});

const CreateTaskSchema = z.object({
  contact_id: z.number().int().describe("ID of the contact this task is linked to"),
  type: z.string().describe("Task type (e.g. 'Call', 'Email', 'Meeting', 'Follow-up', 'Other')"),
  text: z.string().min(1).describe("Task description"),
  due_date: z.string().describe("Due date as ISO 8601 timestamp (e.g. '2026-04-15T10:00:00Z')"),
  sales_id: z.number().int().optional().describe("ID of the sales person responsible for this task"),
});

const CompleteTaskSchema = z.object({
  id: z.number().int().describe("ID of the task to mark as completed"),
});

const DeleteTaskSchema = z.object({
  id: z.number().int().describe("ID of the task to delete"),
});

// ── Register ──────────────────────────────────────────────────────────────────

export function registerTaskTools(server: McpServer, client: SupabaseClient): void {

  // ── crm_list_tasks ───────────────────────────────────────────────────────────
  server.registerTool(
    "crm_list_tasks",
    {
      title: "List Tasks",
      description: `Returns tasks from Atomic CRM, ordered by due_date ascending.

By default returns only pending tasks (done_date IS NULL).
Set pending_only: false to include completed tasks too.

Can filter by contact or by the assigned sales person.

Each task includes: id, contact_id, type, text, due_date, done_date, sales_id.

Examples:
  - All my pending tasks:     { pending_only: true }
  - Tasks for a contact:      { contact_id: 42 }
  - Completed tasks:          { pending_only: false }`,
      inputSchema: ListTasksSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ contact_id, sales_id, pending_only, limit, offset }) => {
      try {
        let query = client
          .from("tasks")
          .select("*", { count: "exact" })
          .order("due_date", { ascending: true })
          .range(offset, offset + limit - 1);

        if (contact_id !== undefined) query = query.eq("contact_id", contact_id);
        if (sales_id !== undefined) query = query.eq("sales_id", sales_id);
        if (pending_only) query = query.is("done_date", null);

        const { data, error, count } = await query;
        if (error) throw new Error(error.message);

        return { content: [{ type: "text" as const, text: toText({ ...paginationMeta(count ?? 0, offset, data?.length ?? 0), data: data ?? [] }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `Error listing tasks: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── crm_create_task ──────────────────────────────────────────────────────────
  server.registerTool(
    "crm_create_task",
    {
      title: "Create Task",
      description: `Creates a new task linked to a contact.

Required: contact_id, type, text, due_date.
Common types: 'Call', 'Email', 'Meeting', 'Follow-up', 'Other'.
due_date must be an ISO 8601 timestamp.

Returns the newly created task record.`,
      inputSchema: CreateTaskSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ contact_id, type, text, due_date, sales_id }) => {
      try {
        const { data, error } = await client
          .from("tasks")
          .insert({ contact_id, type, text, due_date, sales_id })
          .select()
          .single();

        if (error) throw new Error(error.message);
        return { content: [{ type: "text" as const, text: toText(data) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `Error creating task: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── crm_complete_task ────────────────────────────────────────────────────────
  server.registerTool(
    "crm_complete_task",
    {
      title: "Complete Task",
      description: `Marks a task as completed by setting done_date to now.

Returns the updated task record.`,
      inputSchema: CompleteTaskSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const { data, error } = await client
          .from("tasks")
          .update({ done_date: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();

        if (error) {
          if (error.code === "PGRST116") return { isError: true, content: [{ type: "text" as const, text: `Task ${id} not found.` }] };
          throw new Error(error.message);
        }
        return { content: [{ type: "text" as const, text: toText(data) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `Error completing task ${id}: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  // ── crm_delete_task ──────────────────────────────────────────────────────────
  server.registerTool(
    "crm_delete_task",
    {
      title: "Delete Task",
      description: `Permanently deletes a task. This action is irreversible.

Returns a confirmation message on success.`,
      inputSchema: DeleteTaskSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const { error } = await client.from("tasks").delete().eq("id", id);
        if (error) throw new Error(error.message);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, deleted_id: id }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: `Error deleting task ${id}: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );
}
