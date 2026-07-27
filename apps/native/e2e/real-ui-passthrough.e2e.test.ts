/**
 * local-api e2e: the OTHER half of the real-UI interception contract — a
 * route the interception table does NOT recognize still reaches the
 * (stub) upstream unchanged, bearer-authenticated, exactly like the
 * pre-existing app-API proxy always has (bare paths now, no `/upstream`
 * prefix — see the port-router split). See
 * the native interception contract §2.3 ("org CRUD,
 * connections, members, roles, ... proxy unchanged") and
 * `real-ui-interception.e2e.test.ts` for the routes that ARE intercepted.
 * Also covers the thin-reverse-proxy CATCHALL model
 * (`routes/upstream.rs`'s module doc): a non-`/api/*` path (`/.well-known/*`,
 * standing in for `/mcp`, `/oauth-proxy`, `/org` too — all retargeted to
 * this same bare-path main-listener origin by the SAME web transport,
 * `transport-rules.ts`) forwards through the exact same bearer branch,
 * not a local 404 (there is no `/api/*`-only allowlist on this proxy).
 *
 * Reuses the SAME stub-mesh + `auth_complete_session` bridge pattern as
 * `upstream-auth-proxy.e2e.test.ts` to get a genuinely signed-in OAuth
 * session (process-memory test store; never the developer's Keychain)
 * before asserting on the bearer-forwarding branch.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";

import {
  authHeaders,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

const STUB_SESSION_COOKIE = "better-auth.session_token=passthrough-stub";

/** Same stub-mesh shape as `upstream-auth-proxy.e2e.test.ts`, PLUS one
 *  extra org-scoped route (`GET /api/:org/connections`) standing in for
 *  the many genuinely-proxy-unchanged surfaces map §2.3 lists (org CRUD,
 *  connections, members, roles, settings, task board, ...) — this suite
 *  only needs ONE representative to prove the interception table leaves
 *  it alone. */
function startStubMesh() {
  const connectionsCalls: { authHeader: string | null; path: string }[] = [];
  const wellKnownCalls: { authHeader: string | null; path: string }[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);

      // Stands in for the OTHER paths the web transport retargets to this
      // same bare-path origin besides `/api` — `/mcp`, `/oauth-proxy`,
      // `/.well-known`, `/org` (`transport-rules.ts`). The proxy is a thin
      // catchall (no `/api/*`-only allowlist — see `routes/upstream.rs`'s
      // module doc), so this must reach the stub exactly like `/api/*` does,
      // not 404 locally.
      if (
        u.pathname === "/.well-known/oauth-authorization-server" &&
        req.method === "GET"
      ) {
        wellKnownCalls.push({
          authHeader: req.headers.get("authorization"),
          path: u.pathname,
        });
        return Response.json({ issuer: "stub-issuer" });
      }

      if (u.pathname === "/api/auth/sign-in/email" && req.method === "POST") {
        return new Response(JSON.stringify({ user: { id: "stub-user-1" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": `${STUB_SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
          },
        });
      }
      if (u.pathname === "/api/auth/mcp/register" && req.method === "POST") {
        return Response.json({ client_id: "stub-client-id" });
      }
      if (u.pathname === "/api/auth/mcp/authorize" && req.method === "GET") {
        const cookie = req.headers.get("cookie");
        if (cookie !== STUB_SESSION_COOKIE) {
          return new Response("no session", { status: 401 });
        }
        const redirectUri = u.searchParams.get("redirect_uri")!;
        const state = u.searchParams.get("state") ?? "";
        const target = new URL(redirectUri);
        target.searchParams.set("code", "stub-auth-code");
        target.searchParams.set("state", state);
        return new Response(null, {
          status: 302,
          headers: { location: target.toString() },
        });
      }
      if (u.pathname === "/api/auth/mcp/token" && req.method === "POST") {
        return Response.json({
          access_token: "stub-access-token",
          refresh_token: "stub-refresh-token",
          expires_in: 3600,
          id_token: fakeIdToken({
            sub: "stub-user-1",
            email: "passthrough@example.test",
          }),
        });
      }
      if (u.pathname === "/api/auth/get-session" && req.method === "GET") {
        // Never satisfied by a bare bearer on the REAL server (per the
        // auth recon) — this stub mirrors that shape ONLY for the
        // cookie-persistence suite; unused by this file's own passthrough
        // assertions.
        const cookie = req.headers.get("cookie");
        if (cookie === STUB_SESSION_COOKIE) {
          return Response.json({
            user: { id: "stub-user-1" },
            session: { id: "s1" },
          });
        }
        return new Response(null, { status: 401 });
      }
      if (
        /^\/api\/[^/]+\/connections$/.test(u.pathname) &&
        req.method === "GET"
      ) {
        connectionsCalls.push({
          authHeader: req.headers.get("authorization"),
          path: u.pathname,
        });
        return Response.json({
          connections: [{ id: "conn-1", name: "Stub Connection" }],
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    url: `http://localhost:${server.port}`,
    connectionsCalls,
    wellKnownCalls,
  };
}

describeLocalApi(
  "local-api e2e: real-UI interception — non-intercepted routes pass through unchanged",
  () => {
    let stub: ReturnType<typeof startStubMesh>;
    let a: LocalApi;

    beforeEach(async () => {
      stub = startStubMesh();
      a = await startLocalApi({ DECOCMS_UPSTREAM_URL: stub.url });
    }, HOOK_TIMEOUT_MS);

    afterEach(async () => {
      stub.server.stop(true);
      await stopLocalApi(a);
    }, HOOK_TIMEOUT_MS);

    async function signInAndBridge(): Promise<void> {
      const signIn = await fetch(url(a, "/api/auth/sign-in/email"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ email: "x@example.test", password: "hunter2" }),
      });
      expect(signIn.status).toBe(200);
      const bridge = await fetch(url(a, "/_auth/complete-session"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(bridge.status).toBe(200);
    }

    it("a non-intercepted org route (GET /api/:org/connections) forwards to the stub upstream with the bearer attached", async () => {
      await signInAndBridge();

      const res = await fetch(url(a, "/api/acme/connections"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connections: { id: string }[] };
      expect(body.connections[0]?.id).toBe("conn-1");

      expect(stub.connectionsCalls).toHaveLength(1);
      expect(stub.connectionsCalls[0]?.authHeader).toBe(
        "Bearer stub-access-token",
      );
      expect(stub.connectionsCalls[0]?.path).toBe("/api/acme/connections");
    });

    it("a tool name the interception table doesn't recognize is forwarded too, not answered locally", async () => {
      await signInAndBridge();

      // No stub route for this tool name → the stub's catch-all 404, but
      // critically it's the STUB that answered (proving the request left
      // this process), not a local `{items:[],...}`-shaped interception
      // response.
      const res = await fetch(
        url(a, "/api/acme/tools/SOME_TOOL_LOCAL_API_DOES_NOT_KNOW"),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
    });

    it("without ever signing in, the same route 401s upstream-style (never silently intercepted)", async () => {
      const res = await fetch(url(a, "/api/acme/connections"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; upstream?: boolean };
      expect(body.upstream).toBe(true);
      expect(stub.connectionsCalls).toHaveLength(0);
    });

    // --- Thin reverse-proxy catchall: non-/api paths forward too ------------

    it("a non-/api path (/.well-known/*) forwards to the stub upstream with the bearer attached, not a local 404", async () => {
      await signInAndBridge();

      const res = await fetch(
        url(a, "/.well-known/oauth-authorization-server"),
        { headers: authHeaders() },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { issuer: string };
      expect(body.issuer).toBe("stub-issuer");

      expect(stub.wellKnownCalls).toHaveLength(1);
      expect(stub.wellKnownCalls[0]?.authHeader).toBe(
        "Bearer stub-access-token",
      );
      expect(stub.wellKnownCalls[0]?.path).toBe(
        "/.well-known/oauth-authorization-server",
      );
    });
  },
);
