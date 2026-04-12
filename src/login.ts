#!/usr/bin/env node
/**
 * atomic-crm-mcp login
 *
 * OAuth PKCE login flow for Atomic CRM MCP.
 * Opens a browser, authenticates via SSO (e.g. Authelia), and saves the
 * session tokens to ~/.config/atomic-crm-mcp/session.json so the MCP server
 * can start without interactive prompts.
 *
 * Usage:
 *   SUPABASE_OAUTH_PROVIDER=authelia atomic-crm-mcp login
 *
 * Required env vars:
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_ANON_KEY         — your Supabase anon/public key
 *   SUPABASE_OAUTH_PROVIDER   — provider slug as configured in Supabase
 *                               (e.g. "authelia", "google", "github")
 */

import { createServer } from "http";
import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./constants.js";

const SESSION_DIR = join(homedir(), ".config", "atomic-crm-mcp");
const SESSION_FILE = join(SESSION_DIR, "session.json");
const PORT = 54321;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

// ── Browser launcher ──────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";

  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

// ── Local HTTP server to catch the OAuth callback ────────────────────────────

function waitForCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error_description")
        ?? reqUrl.searchParams.get("error");

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:3rem">
          <h2>&#10003; Login successful</h2>
          <p>You can close this tab and return to the terminal.</p>
        </body></html>`);
        server.close();
        resolve(code);
      } else {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:3rem">
          <h2>Login failed</h2><p>${error ?? "Unknown error"}</p>
        </body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error ?? "unknown"}`));
      }
    });

    server.listen(PORT, "127.0.0.1", () => {
      console.log(`[login] Waiting for OAuth callback on ${REDIRECT_URI} ...`);
    });

    server.on("error", (err) => {
      reject(new Error(`Could not start local server on port ${PORT}: ${err.message}`));
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, TIMEOUT_MS);
  });
}

// ── Token exchange ────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

async function exchangeCodeForSession(code: string, codeVerifier: string): Promise<TokenResponse> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json() as Partial<TokenResponse>;
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Token exchange returned an incomplete session");
  }

  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runLogin(): Promise<void> {
  const provider = process.env.SUPABASE_OAUTH_PROVIDER;
  if (!provider) {
    console.error("[login] Error: SUPABASE_OAUTH_PROVIDER is required");
    console.error("[login] Example: SUPABASE_OAUTH_PROVIDER=authelia atomic-crm-mcp login");
    process.exit(1);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const authUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  authUrl.searchParams.set("provider", provider);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("redirect_to", REDIRECT_URI);

  console.log(`[login] Opening browser for SSO login (provider: ${provider})`);
  console.log(`[login] If the browser does not open, visit:`);
  console.log(`        ${authUrl.toString()}`);

  openBrowser(authUrl.toString());

  const code = await waitForCallback();
  console.log("[login] Authorization code received, exchanging for tokens...");

  const session = await exchangeCodeForSession(code, codeVerifier);

  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });

  console.log(`[login] Session saved to ${SESSION_FILE}`);
  console.log("[login] Done. The MCP server will use this session automatically.");
}
