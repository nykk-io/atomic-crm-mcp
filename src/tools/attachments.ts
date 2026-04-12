import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// ── Input schemas ─────────────────────────────────────────────────────────────

const UploadAttachmentSchema = z.object({
  note_type: z
    .enum(["contact", "deal"])
    .describe("Whether this note belongs to a contact or a deal"),
  note_id: z
    .number()
    .int()
    .describe("ID of the note to attach the file to"),
  filename: z
    .string()
    .min(1)
    .describe("Filename including extension (e.g. 'proposal.pdf', 'screenshot.png')"),
  content_type: z
    .string()
    .min(1)
    .describe("MIME type of the file (e.g. 'application/pdf', 'image/png')"),
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path to the file on disk (e.g. '/home/user/docs/proposal.pdf')"),
});

const DownloadAttachmentSchema = z.object({
  storage_path: z
    .string()
    .min(1)
    .describe(
      "Storage path of the file to download, as returned in the 'path' field of the note's attachments array (format: '{note_type}_notes/{note_id}/{filename}')"
    ),
});

const DeleteAttachmentSchema = z.object({
  note_type: z
    .enum(["contact", "deal"])
    .describe("Whether the note belongs to a contact or a deal"),
  note_id: z
    .number()
    .int()
    .describe("ID of the note that owns the attachment"),
  storage_path: z
    .string()
    .min(1)
    .describe(
      "Storage path of the file to delete, as returned in the 'path' field when the attachment was uploaded"
    ),
});

// ── Register all attachment tools ─────────────────────────────────────────────

export function registerAttachmentTools(
  server: McpServer,
  client: SupabaseClient
): void {
  const BUCKET = "attachments";

  // ── crm_upload_attachment ────────────────────────────────────────────────────
  server.registerTool(
    "crm_upload_attachment",
    {
      title: "Upload Attachment to Note",
      description: `Uploads a file to Supabase Storage and links it to a contact or deal note.

The file is read from disk by the MCP server — pass the absolute path on the local filesystem.
The storage path will be: {note_type}_notes/{note_id}/{filename}

Returns the attachment metadata that was appended to the note's attachments array:
  {
    title: string,       // original filename (shown in the frontend)
    src: string,         // public URL to view/download the file
    path: string,        // storage path (use this to delete later)
    size: number,        // file size in bytes
    type: string,        // MIME type
    uploadedAt: string   // ISO 8601 timestamp
  }

Examples:
  - Attach a PDF to a deal note:
      { note_type: "deal", note_id: 7, filename: "proposal.pdf",
        content_type: "application/pdf",
        file_path: "/home/jaio/Proyectos/quotes/2026/04/proposal.pdf" }`,
      inputSchema: UploadAttachmentSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ note_type, note_id, filename, content_type, file_path }) => {
      try {
        // Read file from disk
        const fileBuffer = await readFile(file_path);
        const storagePath = `${note_type}_notes/${note_id}/${filename}`;

        // Upload to Supabase Storage
        const { error: uploadError } = await client.storage
          .from(BUCKET)
          .upload(storagePath, fileBuffer, {
            contentType: content_type,
            upsert: true,
          });

        if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

        // Get public URL for the uploaded file
        const { data: urlData } = client.storage
          .from(BUCKET)
          .getPublicUrl(storagePath);

        // Build attachment metadata matching the frontend schema
        const attachment = {
          title: filename,
          src: urlData.publicUrl,
          path: storagePath,
          size: fileBuffer.byteLength,
          type: content_type,
          uploadedAt: new Date().toISOString(),
        };

        // Fetch the current note to get existing attachments
        const table = note_type === "contact" ? "contact_notes" : "deal_notes";
        const { data: note, error: fetchError } = await client
          .from(table)
          .select("attachments")
          .eq("id", note_id)
          .single();

        if (fetchError) {
          if (fetchError.code === "PGRST116") {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `${note_type === "contact" ? "Contact" : "Deal"} note ${note_id} not found.`,
                },
              ],
            };
          }
          throw new Error(fetchError.message);
        }

        const existingAttachments: unknown[] = note.attachments ?? [];
        const updatedAttachments = [...existingAttachments, attachment];

        // Update the note's attachments array
        const { error: updateError } = await client
          .from(table)
          .update({ attachments: updatedAttachments })
          .eq("id", note_id);

        if (updateError) throw new Error(`Failed to update note attachments: ${updateError.message}`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, attachment }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error uploading attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_download_attachment ──────────────────────────────────────────────────
  server.registerTool(
    "crm_download_attachment",
    {
      title: "Download Attachment",
      description: `Downloads a file from Supabase Storage by its storage path.

Use crm_list_contact_notes or crm_list_deal_notes to find the storage_path
inside the 'attachments' array of a note.

Return format depends on MIME type:
  - Images (image/*): returned as an inline image the LLM can see directly.
  - Text files (text/*, application/json, etc.): returned as plain text.
  - Other binaries (PDF, Office docs, etc.): returned as base64 with metadata,
    so the LLM can process or forward the content.

Examples:
  - Download a proposal PDF:  { storage_path: "deal_notes/7/proposal.pdf" }
  - Download a screenshot:    { storage_path: "contact_notes/3/screenshot.png" }`,
      inputSchema: DownloadAttachmentSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ storage_path }) => {
      try {
        const { data: blob, error } = await client.storage
          .from(BUCKET)
          .download(storage_path);

        if (error) throw new Error(`Storage download failed: ${error.message}`);
        if (!blob) throw new Error("Storage returned no data");

        const mimeType = blob.type || "application/octet-stream";
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Images: return as MCP image content so the LLM can view them directly
        if (mimeType.startsWith("image/")) {
          return {
            content: [
              {
                type: "image" as const,
                data: buffer.toString("base64"),
                mimeType,
              },
            ],
          };
        }

        // Plain text: return as readable text
        const textTypes = [
          "text/",
          "application/json",
          "application/xml",
          "application/csv",
          "application/javascript",
          "application/typescript",
        ];
        const isText = textTypes.some((t) => mimeType.startsWith(t));
        if (isText) {
          return {
            content: [
              {
                type: "text" as const,
                text: buffer.toString("utf-8"),
              },
            ],
          };
        }

        // Binary (PDF, Office, etc.): return base64 with metadata
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  storage_path,
                  mime_type: mimeType,
                  size_bytes: buffer.byteLength,
                  encoding: "base64",
                  data: buffer.toString("base64"),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error downloading attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // ── crm_delete_attachment ────────────────────────────────────────────────────
  server.registerTool(
    "crm_delete_attachment",
    {
      title: "Delete Attachment from Note",
      description: `Removes a file attachment from a note and deletes it from Supabase Storage.

The storage_path must be the 'path' value returned when the file was uploaded
(format: "{note_type}_notes/{note_id}/{filename}").

Use crm_list_contact_notes or crm_list_deal_notes to inspect the attachments
array of a note and find the correct storage_path.

WARNING: This action is irreversible.

Returns a confirmation message on success.`,
      inputSchema: DeleteAttachmentSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ note_type, note_id, storage_path }) => {
      try {
        const table = note_type === "contact" ? "contact_notes" : "deal_notes";

        // Fetch the current note to get existing attachments
        const { data: note, error: fetchError } = await client
          .from(table)
          .select("attachments")
          .eq("id", note_id)
          .single();

        if (fetchError) {
          if (fetchError.code === "PGRST116") {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `${note_type === "contact" ? "Contact" : "Deal"} note ${note_id} not found.`,
                },
              ],
            };
          }
          throw new Error(fetchError.message);
        }

        type AttachmentRecord = { path?: string; src?: string; [key: string]: unknown };
        const existingAttachments: AttachmentRecord[] = note.attachments ?? [];
        const attachmentExists = existingAttachments.some(
          (a) => a.path === storage_path
        );

        if (!attachmentExists) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Attachment with path "${storage_path}" not found in note ${note_id}.`,
              },
            ],
          };
        }

        // Delete from Supabase Storage
        const { error: storageError } = await client.storage
          .from(BUCKET)
          .remove([storage_path]);

        if (storageError) {
          throw new Error(`Storage deletion failed: ${storageError.message}`);
        }

        // Remove from note's attachments array
        const updatedAttachments = existingAttachments.filter(
          (a) => a.path !== storage_path
        );

        const { error: updateError } = await client
          .from(table)
          .update({ attachments: updatedAttachments })
          .eq("id", note_id);

        if (updateError) {
          throw new Error(`Failed to update note attachments: ${updateError.message}`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, deleted_path: storage_path },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error deleting attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
