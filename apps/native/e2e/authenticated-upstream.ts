/**
 * Minimal authenticated upstream for black-box native tests that exercise
 * account-scoped thread/chat routes. The local bearer authenticates the
 * loopback hop; this fixture establishes the separate upstream identity that
 * owns local threads, matching the native UI's Better Auth -> MCP OAuth flow.
 */
import { authHeaders, jsonAuthHeaders, url, type LocalApi } from "./helpers";

const SESSION_COOKIE = "better-auth.session_token=native-e2e-session";

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

export function startAuthenticatedUpstream() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
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

      return new Response("not found", { status: 404 });
    },
  });

  return { server, url: `http://127.0.0.1:${server.port}` };
}

export async function signInAndCompleteSession(a: LocalApi): Promise<void> {
  const signIn = await fetch(url(a, "/api/auth/sign-in/email"), {
    method: "POST",
    headers: jsonAuthHeaders(),
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
    headers: authHeaders(),
  });
  if (bridge.status !== 200) {
    throw new Error(
      `stub upstream session completion failed (${bridge.status}): ${await bridge.text()}`,
    );
  }
}
