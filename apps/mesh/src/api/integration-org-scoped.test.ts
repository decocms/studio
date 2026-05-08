/**
 * Cross-route integration test for the org-scoped API.
 *
 * Exercises the dual-mounted routes end-to-end against a real (PGlite)
 * test database. Proves that legacy + new paths coexist correctly:
 *   - new path serves AND does NOT log deprecation
 *   - legacy path serves AND DOES log deprecation
 *   - unknown slug → 404 (from resolveOrgFromPath)
 *   - non-member → 403 (from resolveOrgFromPath)
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
  vi,
} from "bun:test";
import { sql } from "kysely";
import { auth } from "../auth";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import type { EventBus } from "../event-bus";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../storage/test-helpers";
import { createApp } from "./app";

/**
 * Create a no-op mock event bus for testing (mirrors integration.test.ts).
 */
function createMockEventBus(): EventBus {
  return {
    start: async () => {},
    stop: () => {},
    isRunning: () => false,
    publish: async () => ({}) as never,
    subscribe: async () => ({}) as never,
    unsubscribe: async () => ({ success: true }),
    listSubscriptions: async () => [],
    getSubscription: async () => null,
    getEvent: async () => null,
    cancelEvent: async () => ({ success: true }),
    ackEvent: async () => ({ success: true }),
    syncSubscriptions: async () => ({
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      subscriptions: [],
    }),
  };
}

/**
 * Build a verifyApiKey mock that returns a valid key bound to the given
 * userId + org. Lets us swap principals between tests (member vs non-member).
 */
function mockApiKey(userId: string, orgId: string, orgSlug: string) {
  vi.spyOn(auth.api, "verifyApiKey").mockResolvedValue({
    valid: true,
    error: null,
    key: {
      id: "test-key-id",
      name: "Test API Key",
      userId,
      // No permissions field — we don't need RBAC for the routes under test.
      // The handlers only check that ctx.organization.id is set + a real
      // connection exists.
      permissions: undefined,
      metadata: {
        organization: { id: orgId, slug: orgSlug, name: orgSlug },
      },
    },
    // oxlint-disable-next-line no-explicit-any
  } as never);
}

describe("org-scoped API coexistence", () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);

    // Seed a second user (NOT a member of org_1) — used by the 403 test.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES ('user_outsider', 'outsider@test.com', 0, 'Outsider', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    // Seed a membership for user_1 in org_1 so resolveOrgFromPath admits us.
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_1', 'user_1', 'org_1', 'member', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    // Seed a connection owned by org_1 — the route under test does
    // findById(connectionId, organizationId), so this row must exist for both
    // the legacy path (200) and the new path (200) to succeed.
    await database.db
      .insertInto("connections")
      .values({
        id: "conn_1",
        organization_id: "org_1",
        created_by: "user_1",
        title: "Test Connection",
        connection_type: "HTTP",
        connection_url: "https://example.test",
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Build the app against the seeded DB. Production deps that aren't relevant
    // here (NATS, automations, decopilot streams) are stubbed by createApp when
    // an explicit eventBus is passed.
    app = await createApp({ database, eventBus: createMockEventBus() });

    // Default principal: user_1 (member of org_1). Tests can override.
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    mockApiKey("user_1", "org_1", "org_1");

    // Spy on console.log AFTER createApp ran (createApp emits its own startup
    // logs that we don't want to assert on).
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    await closeTestDatabase(database);
  });

  it("new path serves the route AND does NOT log deprecation", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/connections/conn_1/oauth-token/status",
        { headers: { Authorization: "Bearer test-key" } },
      ),
    );

    expect(res.status).toBe(200);

    const deprecationCalls = logSpy.mock.calls.filter(
      (args: unknown[]) => args[0] === "deprecated route",
    );
    expect(deprecationCalls).toHaveLength(0);
  });

  it("legacy path still serves AND DOES log deprecation", async () => {
    const res = await app.fetch(
      new Request("http://test/api/connections/conn_1/oauth-token/status", {
        headers: {
          Authorization: "Bearer test-key",
          // x-org-id is redundant when the API key carries org metadata, but
          // we send it to mirror the documented legacy contract.
          "x-org-id": "org_1",
        },
      }),
    );

    expect(res.status).toBe(200);

    const deprecationCalls = logSpy.mock.calls.filter(
      (args: unknown[]) => args[0] === "deprecated route",
    );
    expect(deprecationCalls.length).toBeGreaterThan(0);
  });

  it("new path returns 404 for unknown slug", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/non-existent-slug/connections/conn_1/oauth-token/status",
        { headers: { Authorization: "Bearer test-key" } },
      ),
    );

    expect(res.status).toBe(404);
  });

  it("new path returns 403 for non-member principal", async () => {
    // Swap the API key mock so the request is authenticated as user_outsider,
    // who has no membership row in org_1.
    mockApiKey("user_outsider", "org_1", "org_1");

    const res = await app.fetch(
      new Request(
        "http://test/api/org_1/connections/conn_1/oauth-token/status",
        { headers: { Authorization: "Bearer test-key" } },
      ),
    );

    expect(res.status).toBe(403);
  });

  it("well-known prefix discovery for org-scoped MCP resolves the right org", async () => {
    // The MCP SDK probes /.well-known/oauth-protected-resource{resource-path}
    // (RFC 9728 Format 2 / Smithery-style) to discover OAuth metadata. With
    // org-scoped server URLs the probe path is
    // /.well-known/oauth-protected-resource/api/:org/mcp/:connectionId — this
    // path lives at the *root* (the well-known prefix is anchored there), not
    // under the /api/:org sub-app. Without a top-level mount the SDK gets a
    // 404 here and falls back to treating the mesh root as the auth server,
    // breaking every OAuth-gated MCP (GitHub import-from-repo, Cursor, etc.).

    // Mock the origin: well-known endpoints 404, but the initialize probe
    // returns a Bearer challenge with resource_metadata so checkOriginSupports
    // OAuth resolves true. The handler then synthesizes metadata pointing at
    // our proxy — and crucially MUST use the org-scoped /api/:org/... path
    // (not the legacy /mcp/:id shape) for both `resource` and
    // `authorization_servers`, otherwise the SDK's resource-allowed check
    // fails.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      _input,
      init,
    ) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        // Origin's MCP `initialize` probe — return an OAuth 401.
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer realm="origin", resource_metadata="https://example.test/.well-known/oauth-protected-resource"',
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    // Use a localhost-shaped host so the handler's `fixProtocol` keeps the
    // http scheme (it forces https for non-localhost hosts).
    const reqHost = "http://mesh.localhost";
    try {
      const res = await app.fetch(
        new Request(
          `${reqHost}/.well-known/oauth-protected-resource/api/org_1/mcp/conn_1`,
        ),
      );

      // Route must exist (was 404 before the fix — no route was mounted for
      // this URL shape outside the /api/:org sub-app).
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
      };
      // Synthetic metadata MUST use the org-scoped /api/:org/... path for
      // `resource` so resourceUrlFromServerUrl(serverUrl) matches
      // resourceMetadata.resource (the SDK's checkResourceAllowed check);
      // otherwise OAuth fails with "Protected resource ... does not match
      // expected ...".
      expect(body.resource).toBe(`${reqHost}/api/org_1/mcp/conn_1`);
      // The auth-server URL stays on the legacy `/oauth-proxy/:id` path so
      // the SDK's RFC 8414 discovery hits the dedicated auth-server metadata
      // handler (which proxies the origin's metadata) instead of falling
      // through to Better Auth's catch-all — that path returns Better Auth's
      // MCP gateway endpoints and DCR ends with `invalid_client`.
      expect(body.authorization_servers[0]).toBe(
        `${reqHost}/oauth-proxy/conn_1`,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("well-known prefix discovery uses the path slug, not the session's active org", async () => {
    // Regression for #3272 fallout: multi-org users hitting another org's
    // URL would 404 here because the handler resolved `orgSlug` as
    // `ctx.organization?.slug ?? c.req.param("org")`. The well-known prefix
    // route is mounted at the URL root (outside `/api/:org`), so
    // `resolveOrgFromPath` doesn't run — `ctx.organization` falls through to
    // the session's `activeOrganizationId`, which silently overrode the path
    // slug. For a user whose active org is `org_456`, a discovery probe at
    // `/api/org_1/mcp/conn_1` would scope the lookup to `org_456` and 404
    // even though the path AND the connection both belong to `org_1`. Fix:
    // path param takes priority — `c.req.param("org") ?? ctx.organization?.slug`.
    mockApiKey("user_1", "org_456", "org_456");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      _input,
      init,
    ) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer realm="origin", resource_metadata="https://example.test/.well-known/oauth-protected-resource"',
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    try {
      const res = await app.fetch(
        new Request(
          "http://mesh.localhost/.well-known/oauth-protected-resource/api/org_1/mcp/conn_1",
          { headers: { Authorization: "Bearer test-key" } },
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: string };
      expect(body.resource).toBe("http://mesh.localhost/api/org_1/mcp/conn_1");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("well-known prefix discovery 404s when :org doesn't match the connection's org", async () => {
    // The synthesized PRM URL embeds :org as part of the resource path, so
    // the handler MUST refuse to vouch for (org, connection) tuples that
    // don't match — otherwise an attacker could probe a victim's connection
    // ID under their own org slug and get a credible-looking metadata
    // document. We don't distinguish "unknown org" from "cross-org" in the
    // response so we don't leak which slugs exist.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }) as never);

    try {
      // Cross-org: org_456 exists (seeded by seedCommonTestFixtures) but
      // conn_1 belongs to org_1.
      const crossOrg = await app.fetch(
        new Request(
          "http://mesh.localhost/.well-known/oauth-protected-resource/api/org_456/mcp/conn_1",
        ),
      );
      expect(crossOrg.status).toBe(404);

      // Unknown slug: same response shape as cross-org.
      const unknownSlug = await app.fetch(
        new Request(
          "http://mesh.localhost/.well-known/oauth-protected-resource/api/does-not-exist/mcp/conn_1",
        ),
      );
      expect(unknownSlug.status).toBe(404);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("auth-server metadata advertises org-scoped OAuth endpoint URLs", async () => {
    // Regression for the popup-not-opening bug: the AS metadata route lives at
    // the legacy global path (kept stable for SDK cache + Better Auth catch-all
    // reasons), but the OAuth endpoint URLs *inside* must point at the
    // canonical `/api/:org/oauth-proxy/...` mount. Otherwise DCR
    // (POST /register) lands on the legacy mount, where `ctx.organization`
    // falls back to the session's `activeOrganizationId` and silently 404s
    // multi-org users whose active session org doesn't match the connection's.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({
            resource: "https://example.test",
            authorization_servers: ["https://example.test"],
          }),
          { status: 200 },
        );
      }
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://example.test",
            authorization_endpoint: "https://example.test/authorize",
            token_endpoint: "https://example.test/token",
            registration_endpoint: "https://example.test/register",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    try {
      const res = await app.fetch(
        new Request(
          "http://mesh.localhost/.well-known/oauth-authorization-server/oauth-proxy/conn_1",
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        authorization_endpoint: string;
        token_endpoint: string;
        registration_endpoint: string;
      };
      expect(body.authorization_endpoint).toBe(
        "http://mesh.localhost/api/org_1/oauth-proxy/conn_1/authorize",
      );
      expect(body.token_endpoint).toBe(
        "http://mesh.localhost/api/org_1/oauth-proxy/conn_1/token",
      );
      expect(body.registration_endpoint).toBe(
        "http://mesh.localhost/api/org_1/oauth-proxy/conn_1/register",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("DCR survives a multi-org user whose session active org differs from the path", async () => {
    // The popup-not-opening bug surfaced because DCR (the SDK's
    // POST /register call right before opening the authorize popup) hit the
    // legacy `/oauth-proxy/:connectionId/*` mount and 404'd against the
    // session's `activeOrganizationId`. With the AS metadata now pointing at
    // `/api/:org/oauth-proxy/...`, `resolveOrgFromPath` resolves the org from
    // the URL and verifies membership instead — independent of session state.

    // Seed user_1 into a second org and switch the active session there. The
    // path under test still names org_1 (where conn_1 lives).
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_1_456', 'user_1', 'org_456', 'member', ${new Date().toISOString()})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    mockApiKey("user_1", "org_456", "org_456");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      // Origin's AS metadata exposes a registration endpoint.
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://example.test",
            authorization_endpoint: "https://example.test/authorize",
            token_endpoint: "https://example.test/token",
            registration_endpoint: "https://example.test/register",
          }),
          { status: 200 },
        );
      }
      // Origin accepts our DCR proxy.
      if (url.endsWith("/register") && method === "POST") {
        return new Response(
          JSON.stringify({ client_id: "client_xyz", client_secret: "secret" }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    try {
      const res = await app.fetch(
        new Request(
          "http://mesh.localhost/api/org_1/oauth-proxy/conn_1/register",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer test-key",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              client_name: "test",
              redirect_uris: ["http://mesh.localhost/oauth/callback"],
            }),
          },
        ),
      );

      // Pre-fix: 404 ("Connection not found") because the legacy mount's
      // cross-org check fired against the session's active org (org_456) and
      // mismatched conn_1's owning org (org_1).
      expect(res.status).not.toBe(404);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(400);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("oauth-proxy refuses slug-spoofing on the org-scoped mount", async () => {
    // Member of both org_1 and org_456 asks for an org_1 connection under
    // org_456's slug. The path-resolved org scopes the connection lookup, so
    // findById returns null and the handler 404s — preventing OAuth proxying
    // for connections that don't belong to the URL's org.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_1_456_spoof', 'user_1', 'org_456', 'member', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    const res = await app.fetch(
      new Request(
        "http://mesh.localhost/api/org_456/oauth-proxy/conn_1/register",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ client_name: "test" }),
        },
      ),
    );

    expect(res.status).toBe(404);
  });

  it("DCR injects the connection's owning org into the registration metadata", async () => {
    // The downstream MCP App needs to know which studio org an OAuth client
    // belongs to *at registration time* — there is no per-user "active org"
    // concept on the server, and querying it back from a bearer token has no
    // standard. The proxy threads `connection.organization_id` (plus slug/name
    // for human-readable references) into the RFC 7591 `metadata` field, which
    // downstream servers can read off the persisted oauthApplication row on
    // every subsequent request.
    let capturedBody: string | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://example.test",
            authorization_endpoint: "https://example.test/authorize",
            token_endpoint: "https://example.test/token",
            registration_endpoint: "https://example.test/register",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/register") && method === "POST") {
        capturedBody =
          typeof init?.body === "string"
            ? init.body
            : await new Response(init?.body).text();
        return new Response(
          JSON.stringify({ client_id: "client_xyz", client_secret: "secret" }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    try {
      const res = await app.fetch(
        new Request(
          "http://mesh.localhost/api/org_1/oauth-proxy/conn_1/register",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer test-key",
              // Mixed-case media type — case-insensitive per RFC 7231 §3.1.1.1.
              // Locks in that the injection branch normalizes before matching.
              "Content-Type": "Application/JSON",
            },
            body: JSON.stringify({
              client_name: "test",
              redirect_uris: ["http://mesh.localhost/oauth/callback"],
              metadata: { existing_key: "preserved" },
            }),
          },
        ),
      );

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(400);
      expect(capturedBody).not.toBeNull();
      const forwarded = JSON.parse(capturedBody!);
      // Original fields untouched.
      expect(forwarded.client_name).toBe("test");
      expect(forwarded.redirect_uris).toEqual([
        "http://mesh.localhost/oauth/callback",
      ]);
      // Org metadata injected; pre-existing metadata keys preserved.
      expect(forwarded.metadata).toEqual({
        existing_key: "preserved",
        organization_id: "org_1",
        organization_slug: "org_1",
        organization_name: "org_1",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("DCR passes through non-object JSON bodies unchanged", async () => {
    // null/array/primitive bodies are non-spec for DCR (RFC 7591 requires a
    // JSON object). The proxy must not try to attach `metadata` to them —
    // null/primitive would throw on property assignment, and arrays would
    // silently lose the property at JSON.stringify time. We forward unchanged
    // and let origin return its own 4xx.
    const captured: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://example.test",
            authorization_endpoint: "https://example.test/authorize",
            token_endpoint: "https://example.test/token",
            registration_endpoint: "https://example.test/register",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/register") && method === "POST") {
        const body =
          typeof init?.body === "string"
            ? init.body
            : await new Response(init?.body).text();
        captured.push(body);
        return new Response(
          JSON.stringify({ error: "invalid_client_metadata" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    try {
      for (const body of ["null", "[1,2,3]", "42"]) {
        const res = await app.fetch(
          new Request(
            "http://mesh.localhost/api/org_1/oauth-proxy/conn_1/register",
            {
              method: "POST",
              headers: {
                Authorization: "Bearer test-key",
                "Content-Type": "application/json",
              },
              body,
            },
          ),
        );
        // Proxy didn't crash (would have been a 500); origin's 400 is what
        // surfaces to the client.
        expect(res.status).toBe(400);
      }
      expect(captured).toEqual(["null", "[1,2,3]", "42"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("DCR with non-JSON content type passes through byte-for-byte", async () => {
    // RFC 7591 mandates JSON, but a misbehaving client could POST /register
    // with a different content type. The metadata-injection branch is gated on
    // `application/json` so non-JSON bodies hit the raw-body passthrough and
    // reach origin unchanged (no UTF-8 decode/re-encode, no Content-Type
    // override).
    const captured: { body: string | null; contentType: string | null } = {
      body: null,
      contentType: null,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://example.test",
            authorization_endpoint: "https://example.test/authorize",
            token_endpoint: "https://example.test/token",
            registration_endpoint: "https://example.test/register",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/register") && method === "POST") {
        captured.body =
          typeof init?.body === "string"
            ? init.body
            : await new Response(init?.body).text();
        const headers = new Headers(init?.headers as HeadersInit | undefined);
        captured.contentType = headers.get("Content-Type");
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    try {
      const rawBody = "client_name=test&redirect_uris=http://x";
      const res = await app.fetch(
        new Request(
          "http://mesh.localhost/api/org_1/oauth-proxy/conn_1/register",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer test-key",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: rawBody,
          },
        ),
      );

      expect(res.status).toBe(200);
      expect(captured.body).toBe(rawBody);
      expect(captured.contentType).toBe("application/x-www-form-urlencoded");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
