function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(
      `[config] Missing required environment variable: ${name}\n` +
      `[config] Set it when registering the MCP server, for example:\n` +
      `[config]   claude mcp add atomic-crm -e ${name}=<value> -- npx -y @nykk/atomic-crm-mcp\n`
    );
    process.exit(1);
  }
  return value;
}

export const SUPABASE_URL = requireEnv("SUPABASE_URL");

// The anon/publishable key is safe to expose — it has no special privileges.
// Row-level security (RLS) in Supabase controls what each authenticated user can access.
export const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");

// Max characters returned in a single tool response.
// Prevents overwhelming the LLM context window.
export const CHARACTER_LIMIT = 25_000;

// Max size for base64-encoded file uploads (~7.5 MB decoded).
// Prevents memory exhaustion from oversized payloads.
export const MAX_UPLOAD_BASE64_CHARS = 10_000_000;
