/**
 * Authentication module for Atomic CRM MCP.
 *
 * Auth strategy (tried in order):
 *
 * 1. SUPABASE_SERVICE_ROLE_KEY  → admin client, no user auth needed.
 *    Use this for local dev or automated pipelines with full access.
 *
 * 2. SUPABASE_EMAIL + SUPABASE_PASSWORD env vars  → non-interactive login.
 *    Recommended for Claude Desktop: set credentials in the MCP config.
 *
 * 3. Saved session (~/.config/atomic-crm-mcp/session.json)  → auto-refresh.
 *    After a successful interactive login, the refresh token is persisted so
 *    the user doesn't have to log in again on every start.
 *
 * 4. Interactive login via stderr  → prompts email + password on first run.
 *    Stdin/stdout belong to the MCP protocol, so prompts go to stderr.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as readline from "readline";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./constants.js";

// Where the session tokens are persisted between runs.
const SESSION_DIR = join(homedir(), ".config", "atomic-crm-mcp");
const SESSION_FILE = join(SESSION_DIR, "session.json");

interface SavedSession {
  access_token: string;
  refresh_token: string;
}

function loadSavedSession(): SavedSession | null {
  try {
    if (existsSync(SESSION_FILE)) {
      const raw = readFileSync(SESSION_FILE, "utf-8");
      const parsed = JSON.parse(raw) as SavedSession;
      if (parsed.access_token && parsed.refresh_token) return parsed;
    }
  } catch {
    // Corrupt file — treat as no session.
  }
  return null;
}

function saveSession(access_token: string, refresh_token: string): void {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  const data: SavedSession = { access_token, refresh_token };
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function clearSession(): void {
  try {
    if (existsSync(SESSION_FILE)) writeFileSync(SESSION_FILE, "{}");
  } catch {
    // Best-effort.
  }
}

/** Ask the user a question via stderr (stdout is reserved for MCP). */
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Ask for a password without echoing characters to stderr. */
function askPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    let input = "";

    const onData = (char: string) => {
      if (char === "\r" || char === "\n") {
        // Enter pressed — done
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(input);
      } else if (char === "\u0003") {
        // Ctrl+C
        process.stderr.write("\n");
        process.exit(1);
      } else if (char === "\u007f" || char === "\b") {
        // Backspace
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Creates an authenticated Supabase client using the best available method.
 * Throws if authentication fails at every level.
 */
export async function createAuthenticatedClient(): Promise<SupabaseClient> {
  // ── Level 1: service role key (admin, no user needed) ───────────────────────
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    process.stderr.write("[auth] Using service role key (admin access)\n");
    return createClient(SUPABASE_URL, serviceKey, {
      auth: { persistSession: false },
    });
  }

  // ── Level 2: email + password from env vars (non-interactive) ───────────────
  const email = process.env.SUPABASE_EMAIL;
  const password = process.env.SUPABASE_PASSWORD;
  if (email && password) {
    process.stderr.write(`[auth] Signing in as ${email} (from env vars)\n`);
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      throw new Error(`[auth] Login failed: ${error?.message ?? "no session returned"}`);
    }
    saveSession(data.session.access_token, data.session.refresh_token);
    process.stderr.write("[auth] Signed in successfully\n");
    return client;
  }

  // ── Level 3: saved session (auto-refresh) ───────────────────────────────────
  const saved = loadSavedSession();
  if (saved) {
    process.stderr.write("[auth] Restoring saved session…\n");
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await client.auth.setSession(saved);
    if (!error && data.session) {
      saveSession(data.session.access_token, data.session.refresh_token);
      process.stderr.write("[auth] Session refreshed successfully\n");
      return client;
    }
    // Session expired or invalid — fall through to interactive login.
    process.stderr.write("[auth] Saved session is expired, falling back to login\n");
    clearSession();
  }

  // ── Level 4: interactive login via stderr ───────────────────────────────────
  process.stderr.write("\n=== Atomic CRM — Login ===\n");
  const inputEmail = await ask("Email: ");
  const inputPassword = await askPassword("Password: ");

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await client.auth.signInWithPassword({
    email: inputEmail,
    password: inputPassword,
  });

  if (error || !data.session) {
    throw new Error(`[auth] Login failed: ${error?.message ?? "no session returned"}`);
  }

  saveSession(data.session.access_token, data.session.refresh_token);
  process.stderr.write(`[auth] Logged in as ${inputEmail}. Session saved to ${SESSION_FILE}\n`);
  return client;
}
