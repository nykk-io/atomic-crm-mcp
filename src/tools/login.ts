import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "http";
import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../constants.js";

const SESSION_DIR = join(homedir(), ".config", "atomic-crm-mcp");
const SESSION_FILE = join(SESSION_DIR, "session.json");
const PORT = 54321;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TIMEOUT_MS = 5 * 60 * 1000;

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

// ── Browser launcher ─────────────────────────────────────────────────────────

function tryOpenBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";

  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best-effort — the URL is returned to the LLM as fallback.
  }
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
          <p>You can close this tab and return to the conversation.</p>
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

    server.listen(PORT, "127.0.0.1");

    server.on("error", (err) => {
      reject(new Error(`Could not start local server on port ${PORT}: ${err.message}`));
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, TIMEOUT_MS);
  });
}

// ── Token exchange ───────────────────────────────────────────────────────────

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

// ── Session check ────────────────────────────────────────────────────────────

function hasValidSavedSession(): boolean {
  try {
    if (!existsSync(SESSION_FILE)) return false;
    const raw = readFileSync(SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TokenResponse>;
    return !!(parsed.access_token && parsed.refresh_token);
  } catch {
    return false;
  }
}

// ── Tool registration ────────────────────────────────────────────────────────

export function registerLoginTool(server: McpServer): void {
  server.registerTool(
    "crm_login",
    {
      title: "Login via SSO",
      description: `Starts an OAuth PKCE login flow to authenticate with Atomic CRM.

Opens the browser and returns the authorization URL. The user should click the link if the browser did not open automatically.

After the user completes login in the browser, the session is saved automatically and the server can access CRM data.

If a valid session already exists, reports that instead of forcing a new login.`,
      inputSchema: z.object({
        force: z.boolean().optional().describe("Force a new login even if a valid session exists"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ force }) => {
      try {
        // Check for existing session unless force=true
        if (!force && hasValidSavedSession()) {
          return {
            content: [{
              type: "text" as const,
              text: `Already logged in. A valid session exists at ${SESSION_FILE}.\nUse force=true to re-authenticate.`,
            }],
          };
        }

        const provider = process.env.SUPABASE_OAUTH_PROVIDER ?? "keycloak";
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const authUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
        authUrl.searchParams.set("provider", provider);
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("redirect_to", REDIRECT_URI);

        const urlStr = authUrl.toString();

        // Try to open browser automatically
        tryOpenBrowser(urlStr);

        // Return the URL immediately so the LLM can show it
        // Then wait for the callback in the background
        const callbackPromise = waitForCallback();

        // We need to await the callback before returning the final result,
        // but we want to show the URL first. Since MCP tools return a single
        // response, we wait for the full flow to complete.
        //
        // First, log the URL to stderr for visibility
        process.stderr.write(`[login] Auth URL: ${urlStr}\n`);
        process.stderr.write(`[login] Waiting for callback on ${REDIRECT_URI}...\n`);

        const code = await callbackPromise;
        const session = await exchangeCodeForSession(code, codeVerifier);

        if (!existsSync(SESSION_DIR)) {
          mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
        }
        writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });

        return {
          content: [{
            type: "text" as const,
            text: `Login successful! Session saved to ${SESSION_FILE}.\nThe server can now access CRM data. You may need to restart the server for the new session to take effect.`,
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Login failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    }
  );
}
