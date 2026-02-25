/**
 * Mesh authentication module.
 *
 * Provides browser OAuth flow for authenticating against a Mesh instance (Better Auth),
 * API key creation, and persistent token storage in the system keychain.
 *
 * Storage strategy:
 *   - Primary: system keychain (security on macOS, secret-tool on Linux, file fallback on Windows)
 *   - Fallback: ~/.deco_mesh_tokens.json with chmod 600
 *
 * Auth flow: browser OAuth only (no email+password fallback).
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { promises as fsPromises } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

/** Path to the file-based fallback token store */
function getTokenFilePath(): string {
  return join(homedir(), ".deco_mesh_tokens.json");
}

/** Read all tokens from the fallback file (returns empty object on any error) */
async function readTokenFile(): Promise<Record<string, string>> {
  try {
    const content = await fsPromises.readFile(getTokenFilePath(), "utf-8");
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Write tokens to the fallback file with chmod 600 */
async function writeTokenFile(tokens: Record<string, string>): Promise<void> {
  const filePath = getTokenFilePath();
  await fsPromises.writeFile(filePath, JSON.stringify(tokens, null, 2));
  if (process.platform !== "win32") {
    try {
      await fsPromises.chmod(filePath, 0o600);
    } catch {
      // Silently ignore chmod errors
    }
  }
}

/**
 * Read the stored API key for the given Mesh URL from the system keychain.
 * Returns null if not found or if the keychain CLI is unavailable.
 */
export async function readMeshToken(meshUrl: string): Promise<string | null> {
  // Try system keychain first
  try {
    if (process.platform === "darwin") {
      const token = execFileSync(
        "security",
        ["find-generic-password", "-a", "deco-mesh", "-s", meshUrl, "-w"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (token) return token;
    } else if (process.platform === "linux") {
      const token = execFileSync(
        "secret-tool",
        ["lookup", "service", "deco-mesh", "url", meshUrl],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (token) return token;
    }
    // Windows: fall through to file-based storage (cmdkey read is limited)
  } catch {
    // Keychain CLI not available or entry not found — try file fallback
  }

  // File-based fallback
  try {
    const tokens = await readTokenFile();
    return tokens[meshUrl] ?? null;
  } catch {
    return null;
  }
}

/**
 * Save an API key for the given Mesh URL to the system keychain.
 * Falls back to ~/.deco_mesh_tokens.json if the keychain CLI is unavailable.
 */
export async function saveMeshToken(
  meshUrl: string,
  apiKey: string,
): Promise<void> {
  let savedToKeychain = false;

  // Try system keychain first
  try {
    if (process.platform === "darwin") {
      execFileSync(
        "security",
        [
          "add-generic-password",
          "-a",
          "deco-mesh",
          "-s",
          meshUrl,
          "-w",
          apiKey,
          "-U",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      savedToKeychain = true;
    } else if (process.platform === "linux") {
      // secret-tool reads the secret from stdin
      execFileSync(
        "secret-tool",
        [
          "store",
          "--label",
          "deco-mesh",
          "service",
          "deco-mesh",
          "url",
          meshUrl,
        ],
        { input: apiKey, stdio: ["pipe", "pipe", "pipe"] },
      );
      savedToKeychain = true;
    } else if (process.platform === "win32") {
      // cmdkey is limited for reading; skip keychain and go straight to file on Windows
    }
  } catch {
    // Keychain CLI not available
  }

  if (!savedToKeychain) {
    // File-based fallback
    console.warn(
      "Warning: Could not save to system keychain. Storing token in ~/.deco_mesh_tokens.json with restricted permissions.",
    );
    const tokens = await readTokenFile();
    tokens[meshUrl] = apiKey;
    await writeTokenFile(tokens);
  }
}

/** Open the browser to a URL using the platform-appropriate command */
function openBrowser(url: string): void {
  const browserCommands: Record<string, string> = {
    linux: "xdg-open",
    darwin: "open",
    win32: "start",
    freebsd: "xdg-open",
    openbsd: "xdg-open",
    sunos: "xdg-open",
    aix: "open",
  };

  const browser =
    process.env.BROWSER ?? browserCommands[process.platform] ?? "open";

  const command =
    process.platform === "win32" && browser === "start"
      ? spawn("cmd", ["/c", "start", url], { detached: true })
      : spawn(browser, [url], { detached: true });

  command.unref();
  command.on("error", () => {
    // Ignore browser open errors — the URL will be printed as fallback
  });
}

/**
 * Create a persistent API key via the server-side CLI auth endpoint.
 *
 * Uses POST /api/cli/auth which creates the API key server-side with
 * the user's organization embedded in metadata. This avoids Better Auth's
 * client-side restrictions on metadata and permissions fields.
 *
 * Requires a valid session cookie (received from the OAuth callback).
 */
async function createMeshApiKey(
  meshUrl: string,
  sessionCookie: string,
): Promise<string> {
  const res = await fetch(`${meshUrl}/api/cli/auth`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: meshUrl,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to create API key: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { key?: string };
  if (!data.key) {
    throw new Error("Unexpected response from /api/cli/auth — no key field");
  }
  return data.key;
}

/**
 * Authenticate against the Mesh instance using a browser OAuth flow.
 *
 * Flow:
 * 1. Start a local HTTP callback server on a random port.
 * 2. Open browser to ${meshUrl}/login?cli&redirectTo=http://localhost:PORT/callback
 * 3. On callback, extract session cookies from the request.
 * 4. Use the session cookie to call POST /api/auth/api-key/create.
 * 5. Save the API key via saveMeshToken().
 * 6. Return the API key.
 *
 * Rejects after 120 seconds if the user doesn't complete login.
 */
async function runBrowserOAuthFlow(meshUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      server.close();
      reject(
        new Error(
          "Authentication timed out after 120 seconds. Please try again.",
        ),
      );
    }, 120_000);

    const server = createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");

        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        // Extract session cookies forwarded from the Mesh login redirect
        const cookie = req.headers.cookie ?? "";

        // Also check if a token was passed as a query param (alternative strategy)
        const tokenParam = reqUrl.searchParams.get("token");

        let apiKey: string;

        if (tokenParam) {
          // Token passed directly — not currently supported by /api/cli/auth
          // Fall through to cookie-based flow
          apiKey = await createMeshApiKey(meshUrl, "");
        } else if (cookie) {
          // Cookie-based session (standard OAuth redirect)
          apiKey = await createMeshApiKey(meshUrl, cookie);
        } else {
          res.writeHead(400);
          res.end("Authentication failed — no session token received.");
          reject(new Error("No session token received from Mesh login"));
          return;
        }

        // Success response
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Authentication successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>",
        );

        clearTimeout(timeoutHandle);
        server.close(() => {
          saveMeshToken(meshUrl, apiKey)
            .then(() => resolve(apiKey))
            .catch((err) => {
              console.warn(
                "Warning: Could not persist Mesh token:",
                err instanceof Error ? err.message : String(err),
              );
              resolve(apiKey);
            });
        });
      } catch (err) {
        res.writeHead(500);
        res.end("Authentication error — check terminal for details.");
        clearTimeout(timeoutHandle);
        server.close(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
      }
    });

    server.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });

    // Listen on a random port
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 3458;
      const callbackUrl = `http://localhost:${port}/callback`;
      const loginUrl = `${meshUrl}/login?cli&redirectTo=${encodeURIComponent(callbackUrl)}`;

      console.log("Opening browser for Mesh authentication...");
      console.log(
        "If the browser does not open automatically, visit:",
        loginUrl,
      );

      openBrowser(loginUrl);
    });
  });
}

/**
 * Ensure the CLI has a valid Mesh API key for the given Mesh URL.
 *
 * - If a stored token exists, returns it immediately.
 * - If not, starts a browser OAuth flow (120-second timeout).
 *
 * Returns the API key string.
 */
export async function ensureMeshAuth(meshUrl: string): Promise<string> {
  const existing = await readMeshToken(meshUrl);
  if (existing) {
    return existing;
  }

  // No token found — start browser OAuth flow
  const apiKey = await runBrowserOAuthFlow(meshUrl);
  return apiKey;
}
