/**
 * local-api e2e: `/api/auth/*` cookie-jar relay + the
 * `auth_complete_session` hybrid-login bridge.
 *
 * Owner brief (post-v1 feedback, hybrid sign-in design): the desktop
 * embedded login screen submits email/password and email-OTP through
 * `/api/auth/*` (`crates/local-api/src/routes/upstream.rs`'s
 * `proxy_auth_path` branch). That branch has no daemon precedent and no
 * Keychain-stored OAuth bearer to attach yet — it relays a Better Auth
 * session COOKIE via an in-memory, per-process jar
 * (`crates/upstream/src/cookie_jar.rs`) instead. This suite is the
 * black-box contract for that relay, plus the bridge
 * (`POST /_auth/complete-session`, the e2e-reachable HTTP mirror of
 * the `auth_complete_session` Tauri command — see
 * `routes/upstream.rs::complete_session`'s doc comment for why this
 * mirror exists) that consumes the jar's cookie and purges it. Also covers
 * the sibling public/no-auth branch (`GET /api/config`,
 * `proxy_public_config`) the desktop sign-in screen needs BEFORE any
 * upstream session exists at all.
 *
 * Every test spins up its OWN stub Better Auth-shaped upstream (`Bun.serve`,
 * mirrors `daemon.tools.e2e.test.ts`'s stub-MCP-server convention) and its
 * OWN local-api process (fresh `upstream::global()` singleton per process,
 * so each test starts with a genuinely empty cookie jar — no dependency on
 * declaration order between tests).
 */
import { afterEach, beforeEach, expect, it } from "bun:test";

import {
  authHeaders,
  describeLocalApiKeychain,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

/** A signature-less JWT shaped id_token — `decode_id_token` (Rust side)
 *  never verifies the signature (it trusts the token endpoint it just
 *  talked to over TLS), so a stub value here is sufficient. */
function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

const STUB_SESSION_COOKIE = "better-auth.session_token=stub-session-abc";
const KEYRING_SERVICE = `com.decocms.studio.e2e.${process.pid}.${crypto.randomUUID()}`;
const PERSISTENT_TOKEN_STORE = {
  kind: "keychain",
  service: KEYRING_SERVICE,
} as const;

interface SignInCall {
  cookieHeader: string | null;
  originHeader: string | null;
  secFetchSite: string | null;
}

interface ConfigCall {
  authHeader: string | null;
  cookieHeader: string | null;
}

interface GetSessionCall {
  authHeader: string | null;
  cookieHeader: string | null;
}

interface SignOutCall {
  cookieHeader: string | null;
  originHeader: string | null;
  secFetchSite: string | null;
}

interface OrgDataCall {
  authHeader: string | null;
  cookieHeader: string | null;
}

interface TokenCall {
  grantType: string | null;
  refreshToken: string | null;
}

/** Starts a stub upstream implementing just enough of Better Auth's wire
 *  shape for this suite: cookie-issuing sign-in/sign-out, MCP dynamic client
 *  registration, MCP authorize (redirects with a code ONLY when the
 *  expected session cookie is presented — mirrors the real server's
 *  session-gated authorize behavior), token exchange, and token revocation. */
function startStubMesh() {
  const signInCalls: SignInCall[] = [];
  const configCalls: ConfigCall[] = [];
  const getSessionCalls: GetSessionCall[] = [];
  const signOutCalls: SignOutCall[] = [];
  const orgDataCalls: OrgDataCall[] = [];
  const tokenCalls: TokenCall[] = [];
  const probeAuthHeaders: Array<string | null> = [];
  const authLifecycle: string[] = [];
  let authorizeCalls = 0;
  let signOutStatus = 200;
  let initialTokenExpiresIn = 3600;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);

      if (u.pathname === "/api/auth/sign-in/email" && req.method === "POST") {
        signInCalls.push({
          cookieHeader: req.headers.get("cookie"),
          originHeader: req.headers.get("origin"),
          secFetchSite: req.headers.get("sec-fetch-site"),
        });
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
        authorizeCalls++;
        const cookie = req.headers.get("cookie");
        if (cookie !== STUB_SESSION_COOKIE) {
          return new Response("no session", { status: 401 });
        }
        const redirectUri = u.searchParams.get("redirect_uri");
        if (!redirectUri) {
          return new Response("missing redirect_uri", { status: 400 });
        }
        const state = u.searchParams.get("state") ?? "";
        const target = new URL(redirectUri);
        target.searchParams.set("code", "stub-auth-code");
        target.searchParams.set("state", state);
        return new Response(null, {
          status: 302,
          headers: { location: target.toString() },
        });
      }

      // The real production shell's own sign-in gate
      // (`RequiredAuthLayout`/`authClient.useSession()`) hits exactly this
      // native Better Auth endpoint — see `apps/native/docs/
      // the native authentication contract`. Mirrors that endpoint's real shape closely
      // enough for this suite: `200` for a request carrying the SAME
      // cookie `sign-in/email` issued, `401` (bearer-only, no cookie)
      // otherwise — the exact rejection the recon found empirically
      // against the real server.
      if (u.pathname === "/api/auth/get-session" && req.method === "GET") {
        getSessionCalls.push({
          authHeader: req.headers.get("authorization"),
          cookieHeader: req.headers.get("cookie"),
        });
        if (req.headers.get("cookie") === STUB_SESSION_COOKIE) {
          return Response.json({
            user: { id: "stub-user-1" },
            session: { id: "sess-1" },
          });
        }
        return new Response(null, { status: 401 });
      }

      if (u.pathname === "/api/auth/sign-out" && req.method === "POST") {
        signOutCalls.push({
          cookieHeader: req.headers.get("cookie"),
          originHeader: req.headers.get("origin"),
          secFetchSite: req.headers.get("sec-fetch-site"),
        });
        authLifecycle.push("better-auth-sign-out");
        if (signOutStatus !== 200) {
          return Response.json(
            { error: "sign-out failed" },
            { status: signOutStatus },
          );
        }
        if (req.headers.get("cookie") !== STUB_SESSION_COOKIE) {
          return Response.json({ error: "missing session" }, { status: 401 });
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
          },
        });
      }

      if (u.pathname === "/api/auth/mcp/revoke" && req.method === "POST") {
        authLifecycle.push("oauth-revoke");
        return Response.json({ revoked: true });
      }

      // Stands in for an ordinary org-scoped data route (map §2.3) — this
      // suite's cookie-persistence cases assert BOTH the bearer AND the
      // durable cookie ride along on this branch, not just `/api/auth/*`.
      if (/^\/api\/[^/]+\/threads$/.test(u.pathname) && req.method === "GET") {
        orgDataCalls.push({
          authHeader: req.headers.get("authorization"),
          cookieHeader: req.headers.get("cookie"),
        });
        return Response.json({ threads: [] });
      }

      // A connection can require its own OAuth even while the Studio OAuth
      // session is healthy. This is the Faststore task regression: local-api
      // must pass this resource-specific 401 through without clearing the
      // account identity used by the next local thread lookup.
      if (
        u.pathname === "/api/faststore-fila/mcp/conn_faststore" &&
        req.method === "POST"
      ) {
        return new Response("connection authorization required", {
          status: 401,
          headers: {
            "www-authenticate": "Bearer resource-oauth",
          },
        });
      }

      if (u.pathname === "/api/config" && req.method === "GET") {
        configCalls.push({
          authHeader: req.headers.get("authorization"),
          cookieHeader: req.headers.get("cookie"),
        });
        return Response.json({ auth: { emailAndPassword: { enabled: true } } });
      }

      if (u.pathname === "/api/auth/mcp/token" && req.method === "POST") {
        const params = new URLSearchParams(await req.text());
        const grantType = params.get("grant_type");
        tokenCalls.push({
          grantType,
          refreshToken: params.get("refresh_token"),
        });
        if (grantType === "refresh_token") {
          return Response.json({
            access_token: "stub-refreshed-access-token",
            refresh_token: "stub-rotated-refresh-token",
            expires_in: 3600,
          });
        }

        const idToken = fakeIdToken({
          sub: "stub-user-1",
          email: "stub-bridge@example.test",
          name: "Stub Bridge",
        });
        return Response.json({
          access_token: "stub-access-token",
          refresh_token: "stub-refresh-token",
          expires_in: initialTokenExpiresIn,
          id_token: idToken,
        });
      }

      if (u.pathname === "/api/links/me" && req.method === "GET") {
        const authorization = req.headers.get("authorization");
        probeAuthHeaders.push(authorization);
        if (
          authorization === "Bearer stub-access-token" ||
          authorization === "Bearer stub-refreshed-access-token"
        ) {
          return Response.json(null);
        }
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    url: `http://localhost:${server.port}`,
    signInCalls,
    configCalls,
    getSessionCalls,
    signOutCalls,
    orgDataCalls,
    authLifecycle,
    tokenCalls,
    probeAuthHeaders,
    setSignOutStatus: (status: number) => {
      signOutStatus = status;
    },
    setInitialTokenExpiresIn: (seconds: number) => {
      initialTokenExpiresIn = seconds;
    },
    authorizeCallCount: () => authorizeCalls,
  };
}

describeLocalApiKeychain(
  "local-api e2e: /api/auth/* cookie jar + auth_complete_session bridge",
  () => {
    let stub: ReturnType<typeof startStubMesh>;
    let a: LocalApi;

    beforeEach(async () => {
      stub = startStubMesh();
      a = await startLocalApi(
        { DECOCMS_UPSTREAM_URL: stub.url },
        { tokenStore: PERSISTENT_TOKEN_STORE },
      );
    }, HOOK_TIMEOUT_MS);

    afterEach(async () => {
      // Remove the synthetic session while its stub upstream is still alive.
      // The suite uses an isolated Keychain service and fake credentials, but
      // successful cases should not leave even those test entries behind.
      await fetch(url(a, "/_auth/logout"), {
        method: "POST",
        headers: authHeaders(),
      }).catch(() => {});
      await stopLocalApi(a);
      stub.server.stop(true);
    }, HOOK_TIMEOUT_MS);

    it("captures Set-Cookie, never echoes it to the caller, and attaches it on the next auth-path request", async () => {
      const first = await fetch(url(a, "/api/auth/sign-in/email"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ email: "x@example.test", password: "hunter2" }),
      });
      expect(first.status).toBe(200);
      expect(first.headers.get("set-cookie")).toBeNull();
      expect(stub.signInCalls).toHaveLength(1);
      expect(stub.signInCalls[0]?.cookieHeader).toBeNull();

      const second = await fetch(url(a, "/api/auth/sign-in/email"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ email: "x@example.test", password: "hunter2" }),
      });
      expect(second.status).toBe(200);
      expect(second.headers.get("set-cookie")).toBeNull();
      expect(stub.signInCalls).toHaveLength(2);
      expect(stub.signInCalls[1]?.cookieHeader).toBe(STUB_SESSION_COOKIE);
    });

    it("normalizes browser-context headers: the webview Origin never reaches upstream, a first-party Origin does", async () => {
      // The real webview sends `Origin: tauri://localhost` (plus Sec-Fetch-*)
      // on every auth POST; Better Auth's CSRF check rejects unknown Origins,
      // so the proxy must replace them with the upstream's own origin. Found
      // live (the in-app sign-in failed with "Invalid origin") — pinned here
      // because Node fetch sends no Origin and would never catch it.
      const res = await fetch(url(a, "/api/auth/sign-in/email"), {
        method: "POST",
        headers: {
          ...jsonAuthHeaders(),
          Origin: "tauri://localhost",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ email: "x@example.test", password: "hunter2" }),
      });
      expect(res.status).toBe(200);
      const call = stub.signInCalls[0];
      expect(call?.originHeader).toBe(stub.url.replace(/\/$/, ""));
      expect(call?.secFetchSite).toBeNull();
    });

    it("never forwards a caller-supplied Cookie header when the jar is empty", async () => {
      const res = await fetch(url(a, "/api/auth/sign-in/email"), {
        method: "POST",
        headers: {
          ...jsonAuthHeaders(),
          Cookie: "forged=should-never-be-forwarded",
        },
        body: JSON.stringify({ email: "x@example.test", password: "hunter2" }),
      });
      expect(res.status).toBe(200);
      expect(stub.signInCalls[0]?.cookieHeader).toBeNull();
    });

    it("auth_complete_session fails fast when no session cookie has been captured yet", async () => {
      const res = await fetch(url(a, "/_auth/complete-session"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("no upstream session cookie");
      expect(stub.authorizeCallCount()).toBe(0);
    });

    it("auth_complete_session completes the bridge using the jar's cookie, then purges it", async () => {
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
      const body = (await bridge.json()) as {
        signedIn: boolean;
        userLabel: string | null;
      };
      expect(body.signedIn).toBe(true);
      expect(body.userLabel).toBe("stub-bridge@example.test");
      expect(stub.authorizeCallCount()).toBe(1);

      // Purged: a second bridge attempt right after must fail — nothing was
      // re-captured into the jar since the first (successful) attempt.
      const secondBridge = await fetch(url(a, "/_auth/complete-session"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(secondBridge.status).toBe(401);
      const secondBody = (await secondBridge.json()) as { error: string };
      expect(secondBody.error).toContain("no upstream session cookie");
      // The failed retry must not have reached the stub's authorize route at
      // all — `complete_session` fails fast on an empty jar, before any
      // network call.
      expect(stub.authorizeCallCount()).toBe(1);
    });

    it("GET /api/config succeeds with no upstream session at all, carrying neither bearer nor cookie", async () => {
      // The exact pre-sign-in state the desktop sign-in screen's
      // AuthConfigProvider is in when it needs this route most — no prior
      // sign-in call in this test, unlike every case above.
      const res = await fetch(url(a, "/api/config"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        auth: { emailAndPassword: unknown };
      };
      expect(body.auth.emailAndPassword).toEqual({ enabled: true });
      expect(stub.configCalls).toHaveLength(1);
      expect(stub.configCalls[0]?.authHeader).toBeNull();
      expect(stub.configCalls[0]?.cookieHeader).toBeNull();
    });

    // --- Durable cookie: real-UI course-correction ------------------------
    //
    // the native authentication contract found the real production
    // shell's own sign-in gate (`GET /api/auth/get-session`) and org
    // switcher reject a bearer-only session. These cases assert the fix:
    // the cookie that authenticated the embedded sign-in is persisted
    // (Keychain-backed `StoredSession.cookie`) and attached on every
    // app-API call for the rest of the session's life — not just the
    // one `auth_complete_session` bridge round trip.

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

    it("after sign-in + bridge, GET /api/auth/get-session keeps succeeding on LATER requests using the durable cookie (not just the one bridge round trip)", async () => {
      await signInAndBridge();

      // The ephemeral jar was already purged by the bridge — this request
      // can ONLY succeed via the durable, Keychain-persisted cookie.
      const res = await fetch(url(a, "/api/auth/get-session"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(stub.getSessionCalls).toHaveLength(1);
      expect(stub.getSessionCalls[0]?.cookieHeader).toBe(STUB_SESSION_COOKIE);

      // A SECOND later request must ALSO succeed — this isn't a one-shot
      // fallback.
      const again = await fetch(url(a, "/api/auth/get-session"), {
        headers: authHeaders(),
      });
      expect(again.status).toBe(200);
      expect(stub.getSessionCalls).toHaveLength(2);
      expect(stub.getSessionCalls[1]?.cookieHeader).toBe(STUB_SESSION_COOKIE);
    });

    it("ordinary org-data calls carry the durable cookie INSTEAD of the bearer", async () => {
      await signInAndBridge();

      const res = await fetch(url(a, "/api/acme/threads"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(stub.orgDataCalls).toHaveLength(1);
      // Browser-shaped forwarding: with a durable cookie stored, the cookie
      // authenticates and the bearer stays OFF the wire (it remains the 401
      // fallback). Sending both broke upstream tools whose handlers make
      // nested Better Auth calls with the forwarded headers — the api-key
      // plugin probes any bearer as an API key ("Invalid API key.") before
      // the valid cookie beside it is ever consulted.
      expect(stub.orgDataCalls[0]?.authHeader).toBeNull();
      expect(stub.orgDataCalls[0]?.cookieHeader).toBe(STUB_SESSION_COOKIE);
    });

    it("a connection-specific 401 preserves the account scope needed by the next local Faststore task lookup", async () => {
      await signInAndBridge();

      const threadId = "faststore-task-after-resource-401";
      const create = await fetch(
        url(a, "/api/faststore-fila/tools/COLLECTION_THREADS_CREATE"),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({
            data: {
              id: threadId,
              title: "Faststore task",
              virtual_mcp_id: "vir_faststore",
            },
          }),
        },
      );
      expect(create.status).toBe(200);

      const resource = await fetch(
        url(a, "/api/faststore-fila/mcp/conn_faststore"),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: "{}",
        },
      );
      expect(resource.status).toBe(401);
      expect(resource.headers.get("www-authenticate")).toBe(
        "Bearer resource-oauth",
      );
      expect(await resource.text()).toBe("connection authorization required");

      const status = await fetch(url(a, "/_auth/status"), {
        headers: authHeaders(),
      });
      expect(await status.json()).toMatchObject({ signedIn: true });

      const lookup = await fetch(
        url(a, "/api/faststore-fila/tools/COLLECTION_THREADS_GET"),
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: JSON.stringify({ id: threadId }),
        },
      );
      expect(lookup.status).toBe(200);
      expect(await lookup.json()).toMatchObject({
        item: {
          id: threadId,
          organization_id: "faststore-fila",
          created_by: "stub-user-1",
        },
      });
    });

    it("the durable cookie survives a local-api process restart (Keychain-persisted, not just in-memory)", async () => {
      await signInAndBridge();

      // Restart local-api, pointed at the SAME stub mesh (same host →
      // same Keychain "account") — a genuinely NEW process, new in-memory
      // `UpstreamSession` singleton, nothing carried over except what
      // `KeychainTokenStore` persists.
      await stopLocalApi(a);
      a = await startLocalApi(
        { DECOCMS_UPSTREAM_URL: stub.url },
        { tokenStore: PERSISTENT_TOKEN_STORE },
      );

      // This is the exact boot gate used by the Tauri shell. A cookie-only
      // assertion would miss a regression where the durable OAuth record is
      // absent and `auth_status` sends the user back to the login screen.
      const status = await fetch(url(a, "/_auth/status"), {
        headers: authHeaders(),
      });
      expect(await status.json()).toMatchObject({
        signedIn: true,
        userLabel: "stub-bridge@example.test",
        upstreamUrl: stub.url,
      });
      expect(stub.probeAuthHeaders.at(-1)).toBe("Bearer stub-access-token");

      const res = await fetch(url(a, "/api/auth/get-session"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(
        stub.getSessionCalls[stub.getSessionCalls.length - 1]?.cookieHeader,
      ).toBe(STUB_SESSION_COOKIE);
    });

    it("a fresh process silently refreshes an expired Keychain session and persists the rotation for the next restart", async () => {
      // The authorization-code exchange succeeds, but the resulting access
      // token is already expired. `complete-session` may report success for
      // this launch; the fresh process below has no RAM state and must recover
      // exclusively from the durable session, refresh it, and satisfy the
      // same `auth_status` gate the app runs at boot.
      stub.setInitialTokenExpiresIn(0);
      await signInAndBridge();
      expect(stub.tokenCalls).toEqual([
        { grantType: "authorization_code", refreshToken: null },
      ]);

      await stopLocalApi(a);
      a = await startLocalApi(
        { DECOCMS_UPSTREAM_URL: stub.url },
        { tokenStore: PERSISTENT_TOKEN_STORE },
      );

      const firstRestart = await fetch(url(a, "/_auth/status"), {
        headers: authHeaders(),
      });
      expect(await firstRestart.json()).toMatchObject({
        signedIn: true,
        userLabel: "stub-bridge@example.test",
        upstreamUrl: stub.url,
      });
      expect(stub.tokenCalls).toEqual([
        { grantType: "authorization_code", refreshToken: null },
        { grantType: "refresh_token", refreshToken: "stub-refresh-token" },
      ]);
      expect(stub.probeAuthHeaders.at(-1)).toBe(
        "Bearer stub-refreshed-access-token",
      );

      // A second fresh process must load the ROTATED record written by the
      // first one. If refresh only updated RAM, this would spend the original
      // refresh token again (or fail once the real server invalidated it).
      await stopLocalApi(a);
      a = await startLocalApi(
        { DECOCMS_UPSTREAM_URL: stub.url },
        { tokenStore: PERSISTENT_TOKEN_STORE },
      );
      const secondRestart = await fetch(url(a, "/_auth/status"), {
        headers: authHeaders(),
      });
      expect(await secondRestart.json()).toMatchObject({ signedIn: true });
      expect(
        stub.tokenCalls.filter((call) => call.grantType === "refresh_token"),
      ).toHaveLength(1);
      expect(stub.probeAuthHeaders.at(-1)).toBe(
        "Bearer stub-refreshed-access-token",
      );
    });

    it("logout purges the durable cookie together with the rest of the session", async () => {
      await signInAndBridge();

      const logout = await fetch(url(a, "/_auth/logout"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(logout.status).toBe(200);
      const logoutBody = (await logout.json()) as { signedIn: boolean };
      expect(logoutBody.signedIn).toBe(false);

      // Every app-API call after logout must be back to the
      // pre-sign-in state: no bearer, no cookie, the ordinary
      // "unauthorized upstream" envelope.
      const after = await fetch(url(a, "/api/acme/threads"), {
        headers: authHeaders(),
      });
      expect(after.status).toBe(401);
      const afterBody = (await after.json()) as { upstream?: boolean };
      expect(afterBody.upstream).toBe(true);
    });

    it("the real UI's proxied Better Auth sign-out revokes upstream first, then clears native credentials and cookies", async () => {
      await signInAndBridge();

      // Browser-realistic headers: WKWebView sends its non-HTTP origin and
      // Sec-Fetch metadata; the native proxy must normalize them before
      // Better Auth's CSRF check sees the request.
      const signOut = await fetch(url(a, "/api/auth/sign-out"), {
        method: "POST",
        headers: {
          ...jsonAuthHeaders(),
          Origin: "tauri://localhost",
          "Sec-Fetch-Site": "cross-site",
        },
        body: "{}",
      });
      expect(signOut.status).toBe(200);
      expect(signOut.headers.get("set-cookie")).toBeNull();
      expect(stub.signOutCalls).toEqual([
        {
          cookieHeader: STUB_SESSION_COOKIE,
          originHeader: stub.url,
          secFetchSite: null,
        },
      ]);
      expect(stub.authLifecycle).toEqual([
        "better-auth-sign-out",
        "oauth-revoke",
      ]);

      // This is the exact state the Tauri `auth_status` command observes:
      // the HTTP mirror calls the same process-wide UpstreamSession.
      const status = await fetch(url(a, "/_auth/status"), {
        headers: authHeaders(),
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        signedIn: false,
        userLabel: null,
        upstreamUrl: stub.url,
      });

      // Both cookie sources are gone: neither the durable StoredSession nor
      // the ephemeral jar can authenticate a later Better Auth request, and
      // the bridge has no cookie left to consume.
      const getSession = await fetch(url(a, "/api/auth/get-session"), {
        headers: authHeaders(),
      });
      expect(getSession.status).toBe(401);
      expect(
        stub.getSessionCalls[stub.getSessionCalls.length - 1]?.cookieHeader,
      ).toBeNull();

      const bridge = await fetch(url(a, "/_auth/complete-session"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(bridge.status).toBe(401);

      // OAuth credentials are gone too: an ordinary bearer-branch request
      // fails locally and never reaches the upstream stub.
      const orgCallsBefore = stub.orgDataCalls.length;
      const orgData = await fetch(url(a, "/api/acme/threads"), {
        headers: authHeaders(),
      });
      expect(orgData.status).toBe(401);
      expect(stub.orgDataCalls).toHaveLength(orgCallsBefore);

      // Finally prove the durable Keychain entry—not just the in-process
      // cache—was deleted by observing a fresh local-api process against the
      // same upstream host.
      await stopLocalApi(a);
      a = await startLocalApi(
        { DECOCMS_UPSTREAM_URL: stub.url },
        { tokenStore: PERSISTENT_TOKEN_STORE },
      );
      const afterRestart = await fetch(url(a, "/_auth/status"), {
        headers: authHeaders(),
      });
      expect(await afterRestart.json()).toMatchObject({ signedIn: false });
    });

    it("a failed upstream Better Auth sign-out preserves the native session for retry", async () => {
      await signInAndBridge();
      stub.setSignOutStatus(503);

      const signOut = await fetch(url(a, "/api/auth/sign-out"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: "{}",
      });
      expect(signOut.status).toBe(503);
      expect(stub.authLifecycle).toEqual(["better-auth-sign-out"]);

      const status = await fetch(url(a, "/_auth/status"), {
        headers: authHeaders(),
      });
      expect(await status.json()).toMatchObject({ signedIn: true });

      const orgData = await fetch(url(a, "/api/acme/threads"), {
        headers: authHeaders(),
      });
      expect(orgData.status).toBe(200);
      expect(stub.orgDataCalls.at(-1)).toEqual({
        // Cookie-led, bearer held back — same wire contract as every other
        // org-data forward once a durable cookie exists.
        authHeader: null,
        cookieHeader: STUB_SESSION_COOKIE,
      });

      // This case intentionally proved preservation after the failed
      // proxied request; clean up through the still-supported explicit route
      // so the test does not leave a Keychain item for its random stub host.
      const cleanup = await fetch(url(a, "/_auth/logout"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(cleanup.status).toBe(200);
    });
  },
);
