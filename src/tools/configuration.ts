import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";

function toText(data: unknown): string {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= CHARACTER_LIMIT) return text;
  return JSON.stringify(
    { error: "Response truncated", hint: "Use a smaller limit or add filters" },
    null,
    2
  );
}

// ── Defaults (mirrors defaultConfiguration.ts in the frontend) ───────────────

const DEFAULT_DEAL_STAGES = [
  { value: "opportunity", label: "Opportunity" },
  { value: "proposal-sent", label: "Proposal Sent" },
  { value: "in-negociation", label: "In Negotiation" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "delayed", label: "Delayed" },
];

const DEFAULT_DEAL_CATEGORIES = [
  { value: "other", label: "Other" },
  { value: "copywriting", label: "Copywriting" },
  { value: "print-project", label: "Print project" },
  { value: "ui-design", label: "UI Design" },
  { value: "website-design", label: "Website design" },
];

const DEFAULT_COMPANY_SECTORS = [
  { value: "communication-services", label: "Communication Services" },
  { value: "consumer-discretionary", label: "Consumer Discretionary" },
  { value: "consumer-staples", label: "Consumer Staples" },
  { value: "energy", label: "Energy" },
  { value: "financials", label: "Financials" },
  { value: "health-care", label: "Health Care" },
  { value: "industrials", label: "Industrials" },
  { value: "information-technology", label: "Information Technology" },
  { value: "materials", label: "Materials" },
  { value: "real-estate", label: "Real Estate" },
  { value: "utilities", label: "Utilities" },
];

const DEFAULT_NOTE_STATUSES = [
  { value: "cold", label: "Cold" },
  { value: "warm", label: "Warm" },
  { value: "hot", label: "Hot" },
  { value: "in-contract", label: "In Contract" },
];

const DEFAULT_TASK_TYPES = [
  { value: "none", label: "None" },
  { value: "email", label: "Email" },
  { value: "demo", label: "Demo" },
  { value: "lunch", label: "Lunch" },
  { value: "meeting", label: "Meeting" },
  { value: "follow-up", label: "Follow-up" },
  { value: "thank-you", label: "Thank you" },
  { value: "ship", label: "Ship" },
  { value: "call", label: "Call" },
];

// Fixed (not configurable via Settings)
const COMPANY_SIZES = [
  { value: 1, label: "1 employee" },
  { value: 10, label: "2-9 employees" },
  { value: 50, label: "10-49 employees" },
  { value: 250, label: "50-249 employees" },
  { value: 500, label: "250 or more employees" },
];

const CONTACT_GENDERS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "nonbinary", label: "Non-binary" },
];

// ── Register tool ─────────────────────────────────────────────────────────────

export function registerConfigurationTools(
  server: McpServer,
  client: SupabaseClient
): void {
  server.registerTool(
    "crm_get_configuration",
    {
      title: "Get CRM Master Data / Configuration",
      description: `Returns all valid master data values needed to create or edit CRM records.

ALWAYS call this tool before creating or updating deals, companies, contacts, tasks, or notes
to ensure you use valid values for enum fields. Using values not in these lists will break the UI.

Returns:
  {
    dealStages:       [{ value, label }]   — valid values for deal.stage
    dealCategories:   [{ value, label }]   — valid values for deal.category
    companySectors:   [{ value, label }]   — valid values for company.sector
    companySizes:     [{ value, label }]   — valid values for company.size (numeric)
    noteStatuses:     [{ value, label }]   — valid values for contact_note.status
    taskTypes:        [{ value, label }]   — valid values for task.type
    contactGenders:   [{ value, label }]   — valid values for contact.gender
    currency:         string               — configured currency code (e.g. "USD")
  }

Values reflect any customizations made via the Settings page.
Always use the \`value\` field (slug) when writing data, not the \`label\`.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const { data, error } = await client
          .from("configuration")
          .select("config")
          .eq("id", 1)
          .single();

        if (error && error.code !== "PGRST116") throw new Error(error.message);

        const config = (data?.config ?? {}) as Record<string, unknown>;

        const result = {
          dealStages:
            (config.dealStages as typeof DEFAULT_DEAL_STAGES) ??
            DEFAULT_DEAL_STAGES,
          dealCategories:
            (config.dealCategories as typeof DEFAULT_DEAL_CATEGORIES) ??
            DEFAULT_DEAL_CATEGORIES,
          companySectors:
            (config.companySectors as typeof DEFAULT_COMPANY_SECTORS) ??
            DEFAULT_COMPANY_SECTORS,
          companySizes: COMPANY_SIZES,
          noteStatuses:
            (config.noteStatuses as typeof DEFAULT_NOTE_STATUSES) ??
            DEFAULT_NOTE_STATUSES,
          taskTypes:
            (config.taskTypes as typeof DEFAULT_TASK_TYPES) ??
            DEFAULT_TASK_TYPES,
          contactGenders: CONTACT_GENDERS,
          currency:
            typeof config.currency === "string" ? config.currency : "USD",
        };

        return { content: [{ type: "text" as const, text: toText(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error fetching configuration: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
