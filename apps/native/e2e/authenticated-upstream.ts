/**
 * Minimal authenticated upstream for black-box native tests that exercise
 * account-scoped thread/chat routes. The local bearer authenticates the
 * loopback hop; this fixture establishes the separate upstream identity that
 * owns local threads, matching the native UI's Better Auth -> MCP OAuth flow.
 */
import { authHeaders, url, type LocalApi } from "./helpers";

const SESSION_COOKIE = "better-auth.session_token=native-e2e-session";

interface AuthenticatedUpstreamOptions {
  virtualMcps?: Record<string, Record<string, unknown>>;
}

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

export function startAuthenticatedUpstream(
  options: AuthenticatedUpstreamOptions = {},
) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const requestUrl = new URL(req.url);

      if (
        requestUrl.pathname === "/api/auth/sign-in/email" &&
        req.method === "POST"
      ) {
        return new Response(
          JSON.stringify({ user: { id: "sandbox-e2e-user" } }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
            },
          },
        );
      }

      if (
        requestUrl.pathname === "/api/auth/mcp/register" &&
        req.method === "POST"
      ) {
        return Response.json({ client_id: "sandbox-e2e-client" });
      }

      if (
        requestUrl.pathname === "/api/auth/mcp/authorize" &&
        req.method === "GET"
      ) {
        if (req.headers.get("cookie") !== SESSION_COOKIE) {
          return new Response("no session", { status: 401 });
        }
        const redirectUri = requestUrl.searchParams.get("redirect_uri");
        if (!redirectUri) {
          return new Response("missing redirect_uri", { status: 400 });
        }
        const target = new URL(redirectUri);
        target.searchParams.set("code", "sandbox-e2e-auth-code");
        target.searchParams.set(
          "state",
          requestUrl.searchParams.get("state") ?? "",
        );
        return new Response(null, {
          status: 302,
          headers: { location: target.toString() },
        });
      }

      if (
        requestUrl.pathname === "/api/auth/mcp/token" &&
        req.method === "POST"
      ) {
        return Response.json({
          access_token: "sandbox-e2e-access-token",
          refresh_token: "sandbox-e2e-refresh-token",
          expires_in: 3600,
          id_token: fakeIdToken({
            sub: "sandbox-e2e-user",
            email: "sandbox-e2e@example.test",
            name: "Sandbox E2E User",
          }),
        });
      }

      const virtualMcpMatch = requestUrl.pathname.match(
        /^\/api\/[^/]+\/tools\/COLLECTION_VIRTUAL_MCP_GET$/,
      );
      if (virtualMcpMatch && req.method === "POST") {
        const authorized =
          req.headers.get("cookie") === SESSION_COOKIE ||
          req.headers.get("authorization") ===
            "Bearer sandbox-e2e-access-token";
        if (!authorized) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const input = (await req.json()) as { id?: unknown };
        if (typeof input.id !== "string") {
          return Response.json({ error: "id is required" }, { status: 400 });
        }
        const item = options.virtualMcps?.[input.id] ?? null;
        return Response.json({ item });
      }

      const mcpMatch = requestUrl.pathname.match(
        /^\/api\/[^/]+\/mcp\/([^/]+)$/,
      );
      if (mcpMatch && req.method === "GET") {
        // The local terminal capability must be consumed at local-api's
        // guard. Only Studio's own upstream session may cross this proxy
        // boundary; a leaked random terminal bearer deliberately fails.
        const authorized =
          req.headers.get("cookie") === SESSION_COOKIE ||
          req.headers.get("authorization") ===
            "Bearer sandbox-e2e-access-token";
        if (!authorized) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ selectedMcp: decodeURIComponent(mcpMatch[1]!) });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return { server, url: `http://127.0.0.1:${server.port}` };
}

export async function signInAndCompleteSession(
  a: LocalApi,
  privateHeaders: Record<string, string> = authHeaders(),
): Promise<void> {
  const signIn = await fetch(url(a, "/api/auth/sign-in/email"), {
    method: "POST",
    headers: { ...privateHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "sandbox-e2e@example.test",
      password: "hunter2",
    }),
  });
  if (signIn.status !== 200) {
    throw new Error(
      `stub upstream sign-in failed (${signIn.status}): ${await signIn.text()}`,
    );
  }

  const bridge = await fetch(url(a, "/_auth/complete-session"), {
    method: "POST",
    headers: privateHeaders,
  });
  if (bridge.status !== 200) {
    throw new Error(
      `stub upstream session completion failed (${bridge.status}): ${await bridge.text()}`,
    );
  }
}
