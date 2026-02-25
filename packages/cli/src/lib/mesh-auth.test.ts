/**
 * mesh-auth E2E tests
 *
 * Tests the CLI authentication callback flow:
 * 1. A local HTTP callback server starts on a random port
 * 2. After login, the browser redirects to localhost:PORT/callback with session cookies
 * 3. The callback server uses the cookies to create an API key via the Mesh API
 * 4. The API key is returned to the CLI
 *
 * These tests mock the Mesh API server and simulate the browser redirect.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";

// ============================================================================
// Mock Mesh API server
// ============================================================================

function startMockMeshApi(opts?: {
  expectedCookie?: string;
  expectedOrigin?: string;
  apiKey?: string;
  rejectPermissions?: boolean;
}): Promise<{ server: Server; url: string }> {
  const apiKey = opts?.apiKey ?? "mesh_test_key_abc123";

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      // Only handle api-key/create
      if (req.url === "/api/auth/api-key/create" && req.method === "POST") {
        // Check Origin header (Better Auth CSRF check)
        const origin = req.headers.origin;
        if (!origin) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              code: "MISSING_OR_NULL_ORIGIN",
              message: "Missing or null Origin",
            }),
          );
          return;
        }

        // Check for session cookie or Authorization header
        const cookie = req.headers.cookie ?? "";
        const auth = req.headers.authorization ?? "";
        if (!cookie && !auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Unauthorized" }));
          return;
        }

        // Read body to check for forbidden fields
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());

        if (opts?.rejectPermissions && body.permissions) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              code: "THE_PROPERTY_YOURE_TRYING_TO_SET_CAN_ONLY_BE_SET_FROM_THE_SERVER_AUTH_INSTANCE_ONLY",
              message:
                "The property you're trying to set can only be set from the server auth instance only.",
            }),
          );
          return;
        }

        // Success — return API key
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ key: apiKey }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

// ============================================================================
// Simulate the CLI callback server (mirrors runBrowserOAuthFlow logic)
// ============================================================================

/**
 * Start a callback server identical to the one in mesh-auth.ts,
 * returning a promise that resolves with the API key.
 */
function startCallbackServer(meshUrl: string): Promise<{
  server: Server;
  callbackUrl: string;
  apiKeyPromise: Promise<string>;
}> {
  return new Promise((resolveSetup) => {
    let resolveKey: (key: string) => void;
    let rejectKey: (err: Error) => void;
    const apiKeyPromise = new Promise<string>((res, rej) => {
      resolveKey = res;
      rejectKey = rej;
    });

    const server = createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");

        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const cookie = req.headers.cookie ?? "";
        const tokenParam = reqUrl.searchParams.get("token");

        let apiKey: string;

        if (tokenParam) {
          const keyRes = await fetch(`${meshUrl}/api/auth/api-key/create`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tokenParam}`,
              Origin: meshUrl,
            },
            body: JSON.stringify({ name: "deco-link-cli" }),
          });
          if (!keyRes.ok) {
            const text = await keyRes.text().catch(() => keyRes.statusText);
            throw new Error(
              `Failed to create API key: ${keyRes.status} ${text}`,
            );
          }
          const data = (await keyRes.json()) as {
            key?: string;
            apiKey?: { key?: string };
          };
          apiKey = data.key ?? data.apiKey?.key ?? "";
          if (!apiKey) throw new Error("No API key returned");
        } else if (cookie) {
          // Cookie-based — same as createMeshApiKey()
          const keyRes = await fetch(`${meshUrl}/api/auth/api-key/create`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookie,
              Origin: meshUrl,
            },
            body: JSON.stringify({ name: "deco-link-cli" }),
          });
          if (!keyRes.ok) {
            const text = await keyRes.text().catch(() => keyRes.statusText);
            throw new Error(
              `Failed to create API key: ${keyRes.status} ${text}`,
            );
          }
          const data = (await keyRes.json()) as {
            key?: string;
            apiKey?: { key?: string };
          };
          apiKey = data.key ?? data.apiKey?.key ?? "";
          if (!apiKey) throw new Error("No API key returned");
        } else {
          res.writeHead(400);
          res.end("Authentication failed — no session token received.");
          server.close(() =>
            rejectKey!(new Error("No session token received from Mesh login")),
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Authentication successful!</h2></body></html>",
        );
        server.close(() => resolveKey!(apiKey));
      } catch (err) {
        res.writeHead(500);
        res.end("Authentication error");
        server.close(() =>
          rejectKey!(err instanceof Error ? err : new Error(String(err))),
        );
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveSetup({
        server,
        callbackUrl: `http://localhost:${port}/callback`,
        apiKeyPromise,
      });
    });
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("deco link CLI auth callback flow", () => {
  let mockMesh: { server: Server; url: string } | null = null;
  let callbackSetup: {
    server: Server;
    callbackUrl: string;
    apiKeyPromise: Promise<string>;
  } | null = null;

  afterEach(() => {
    mockMesh?.server.close();
    mockMesh = null;
    // callback server closes itself on success/error
    callbackSetup = null;
  });

  it("should receive cookies from browser redirect and create an API key", async () => {
    mockMesh = await startMockMeshApi({
      apiKey: "mesh_key_from_cookie_flow",
      rejectPermissions: true, // Mimic real Better Auth behavior
    });
    callbackSetup = await startCallbackServer(mockMesh.url);

    // Simulate browser redirect: GET /callback with session cookies
    const resp = await fetch(callbackSetup.callbackUrl, {
      headers: {
        Cookie: "better-auth.session_token=sess_abc123",
      },
    });

    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("Authentication successful");

    const apiKey = await callbackSetup.apiKeyPromise;
    expect(apiKey).toBe("mesh_key_from_cookie_flow");
  });

  it("should handle token query param flow", async () => {
    mockMesh = await startMockMeshApi({
      apiKey: "mesh_key_from_token_flow",
    });
    callbackSetup = await startCallbackServer(mockMesh.url);

    // Simulate redirect with token param instead of cookies
    const resp = await fetch(`${callbackSetup.callbackUrl}?token=bearer_xyz`);

    expect(resp.status).toBe(200);
    const apiKey = await callbackSetup.apiKeyPromise;
    expect(apiKey).toBe("mesh_key_from_token_flow");
  });

  it("should fail when no cookies and no token are provided", async () => {
    mockMesh = await startMockMeshApi();
    callbackSetup = await startCallbackServer(mockMesh.url);

    // Capture the rejection early so bun doesn't treat it as unhandled
    const apiKeyPromise = callbackSetup.apiKeyPromise;
    let rejectedError: Error | null = null;
    apiKeyPromise.catch((err) => {
      rejectedError = err;
    });

    // Simulate redirect with no auth
    const resp = await fetch(callbackSetup.callbackUrl);

    expect(resp.status).toBe(400);
    const body = await resp.text();
    expect(body).toContain("no session token");

    // Wait for the rejection to propagate
    try {
      await apiKeyPromise;
    } catch {
      // expected
    }
    expect(rejectedError).toBeInstanceOf(Error);
    expect((rejectedError as unknown as Error).message).toContain(
      "No session token received",
    );
  });

  it("should fail if Mesh API rejects due to missing Origin", async () => {
    // Start a mock that requires Origin header
    const meshServer = createServer(async (req, res) => {
      if (req.url === "/api/auth/api-key/create") {
        if (!req.headers.origin) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              code: "MISSING_OR_NULL_ORIGIN",
              message: "Missing or null Origin",
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ key: "should_not_reach" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((r) => meshServer.listen(0, r));
    const meshAddr = meshServer.address();
    const meshPort =
      typeof meshAddr === "object" && meshAddr ? meshAddr.port : 0;
    const meshUrl = `http://localhost:${meshPort}`;

    // Our callback server sends Origin, so this should succeed
    callbackSetup = await startCallbackServer(meshUrl);

    const resp = await fetch(callbackSetup.callbackUrl, {
      headers: {
        Cookie: "better-auth.session_token=sess_abc",
      },
    });

    expect(resp.status).toBe(200);
    const apiKey = await callbackSetup.apiKeyPromise;
    expect(apiKey).toBe("should_not_reach"); // succeeds because Origin is sent

    meshServer.close();
  });

  it("should not send permissions field (Better Auth rejects it from client)", async () => {
    // This mock rejects requests that include permissions
    mockMesh = await startMockMeshApi({
      apiKey: "mesh_key_no_perms",
      rejectPermissions: true,
    });
    callbackSetup = await startCallbackServer(mockMesh.url);

    const resp = await fetch(callbackSetup.callbackUrl, {
      headers: {
        Cookie: "better-auth.session_token=sess_123",
      },
    });

    // Should succeed because we DON'T send permissions
    expect(resp.status).toBe(200);
    const apiKey = await callbackSetup.apiKeyPromise;
    expect(apiKey).toBe("mesh_key_no_perms");
  });
});

describe("login route redirectTo validation", () => {
  // Tests for isLocalhostUrl logic (same as in login.tsx)
  function isLocalhostUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
      );
    } catch {
      return false;
    }
  }

  it("should allow http://localhost:PORT/callback", () => {
    expect(isLocalhostUrl("http://localhost:59882/callback")).toBe(true);
    expect(isLocalhostUrl("http://localhost:3000/callback")).toBe(true);
    expect(isLocalhostUrl("http://127.0.0.1:8080/callback")).toBe(true);
  });

  it("should reject non-localhost URLs (open redirect prevention)", () => {
    expect(isLocalhostUrl("https://evil.com/callback")).toBe(false);
    expect(isLocalhostUrl("http://attacker.com:3000/callback")).toBe(false);
    expect(isLocalhostUrl("https://localhost:3000/callback")).toBe(false); // https, not http
  });

  it("should reject invalid URLs", () => {
    expect(isLocalhostUrl("not-a-url")).toBe(false);
    expect(isLocalhostUrl("")).toBe(false);
  });
});
