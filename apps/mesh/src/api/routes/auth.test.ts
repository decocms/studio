/**
 * HTTP integration tests for the custom auth routes — specifically the
 * /org-access-status/:slug endpoint that drives the shell layout's
 * "you visited an org you don't belong to" branch.
 *
 * Each test exercises a distinct status branch:
 *   - not-found:        unknown slug
 *   - member:           caller is already in the org
 *   - pending-invite:   caller has a non-expired invitation
 *   - auto-domain-join: org claims the caller's verified email domain
 *   - no-access:        none of the above
 *   - 401:              unauthenticated
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { sql } from "kysely";
import { auth } from "../../auth";
import { __setDbForTesting } from "../../database";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import type { EventBus } from "../../event-bus";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../../storage/test-helpers";
import { createApp } from "../app";

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
 * Convenience: stub the session that the endpoint reads via
 * `auth.api.getSession({ headers })`. Pass `null` to simulate unauthenticated.
 */
function mockSession(
  user: { id: string; email: string; emailVerified: boolean } | null,
) {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    user ? ({ user } as never) : null,
  );
}

describe("GET /api/auth/custom/org-access-status/:slug", () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);

    // The endpoint queries through `getDb()` directly — point the singleton
    // at the test DB so production query paths run against PGlite.
    __setDbForTesting(database);

    const now = new Date().toISOString();

    // user_1 is already seeded (unverified). Add a verified corporate user
    // and a verified user whose org owns no domain (used by the no-access
    // and auto-join tests).
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES ('user_alpha', 'alpha@acme.test', 1, 'Alpha', ${now}, ${now}),
             ('user_outsider', 'outsider@example.com', 1, 'Outsider', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    // user_1 IS a member of org_1 (lets us test the "member" branch).
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_1', 'user_1', 'org_1', 'member', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    app = await createApp({ database, eventBus: createMockEventBus() });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    __setDbForTesting(null);
    await closeTestDatabase(database);
  });

  it("returns 401 when unauthenticated", async () => {
    mockSession(null);
    const res = await app.fetch(
      new Request("http://test/api/auth/custom/org-access-status/org_1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns not-found for an unknown slug", async () => {
    mockSession({
      id: "user_1",
      email: "user_1@test.com",
      emailVerified: true,
    });
    const res = await app.fetch(
      new Request(
        "http://test/api/auth/custom/org-access-status/this-org-doesnt-exist",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not-found" });
  });

  it("returns member when the user already belongs to the org", async () => {
    mockSession({
      id: "user_1",
      email: "user_1@test.com",
      emailVerified: true,
    });
    const res = await app.fetch(
      new Request("http://test/api/auth/custom/org-access-status/org_1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      organization: { slug: string };
    };
    expect(body.status).toBe("member");
    expect(body.organization.slug).toBe("org_1");
  });

  it("returns pending-invite when an invitation matches the caller + org", async () => {
    mockSession({
      id: "user_outsider",
      email: "outsider@example.com",
      emailVerified: true,
    });

    // The endpoint reads invites via `auth.api.listUserInvitations`. Stub it
    // rather than wiring the full Better Auth adapter for one row — the
    // endpoint only cares about (organizationId, status, expiresAt).
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    vi.spyOn(auth.api, "listUserInvitations").mockResolvedValue([
      {
        id: "invite_abc",
        organizationId: "org_456",
        status: "pending",
        expiresAt: futureExpiry,
        // Extra fields the endpoint doesn't look at — kept for type fidelity.
        email: "outsider@example.com",
        role: "member",
        inviterId: "user_1",
      },
    ] as never);

    const res = await app.fetch(
      new Request("http://test/api/auth/custom/org-access-status/org_456"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      invitation: { id: string };
      organization: { slug: string };
    };
    expect(body.status).toBe("pending-invite");
    expect(body.invitation.id).toBe("invite_abc");
    expect(body.organization.slug).toBe("org_456");
  });

  it("ignores expired invitations and falls through to no-access", async () => {
    mockSession({
      id: "user_outsider",
      email: "outsider@example.com",
      emailVerified: true,
    });

    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    vi.spyOn(auth.api, "listUserInvitations").mockResolvedValue([
      {
        id: "invite_expired",
        organizationId: "org_456",
        status: "pending",
        expiresAt: pastExpiry,
        email: "outsider@example.com",
        role: "member",
        inviterId: "user_1",
      },
    ] as never);

    const res = await app.fetch(
      new Request("http://test/api/auth/custom/org-access-status/org_456"),
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("no-access");
  });

  it("returns auto-domain-join when the org claims the caller's verified domain", async () => {
    mockSession({
      id: "user_alpha",
      email: "alpha@acme.test",
      emailVerified: true,
    });
    // No matching invitations.
    vi.spyOn(auth.api, "listUserInvitations").mockResolvedValue([] as never);

    const now = new Date().toISOString();
    await sql`
      INSERT INTO organization_domains
        (organization_id, domain, auto_join_enabled, created_at, updated_at)
      VALUES ('org_456', 'acme.test', true, ${now}, ${now})
    `.execute(database.db);

    const res = await app.fetch(
      new Request("http://test/api/auth/custom/org-access-status/org_456"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      organization: { domain?: string; slug: string };
    };
    expect(body.status).toBe("auto-domain-join");
    expect(body.organization.slug).toBe("org_456");
    expect(body.organization.domain).toBe("acme.test");
  });

  it("does NOT auto-domain-join when auto_join_enabled is false", async () => {
    mockSession({
      id: "user_alpha",
      email: "alpha@acme.test",
      emailVerified: true,
    });
    vi.spyOn(auth.api, "listUserInvitations").mockResolvedValue([] as never);

    const now = new Date().toISOString();
    await sql`
      INSERT INTO organization_domains
        (organization_id, domain, auto_join_enabled, created_at, updated_at)
      VALUES ('org_456', 'acme.test', false, ${now}, ${now})
    `.execute(database.db);

    const res = await app.fetch(
      new Request("http://test/api/auth/custom/org-access-status/org_456"),
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("no-access");
  });

  it("does NOT auto-domain-join for unverified email even if domain matches", async () => {
    mockSession({
      id: "user_alpha",
      email: "alpha@acme.test",
      emailVerified: false,
    });
    vi.spyOn(auth.api, "listUserInvitations").mockResolvedValue([] as never);

    const now = new Date().toISOString();
    await sql`
      INSERT INTO organization_domains
        (organization_id, domain, auto_join_enabled, created_at, updated_at)
      VALUES ('org_456', 'acme.test', true, ${now}, ${now})
    `.execute(database.db);

    const res = await app.fetch(
      new Request("http://test/api/auth/custom/org-access-status/org_456"),
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("no-access");
  });

  it("returns no-access when the user is neither a member nor invited nor auto-join-eligible", async () => {
    mockSession({
      id: "user_outsider",
      email: "outsider@example.com",
      emailVerified: true,
    });
    vi.spyOn(auth.api, "listUserInvitations").mockResolvedValue([] as never);

    const res = await app.fetch(
      new Request("http://test/api/auth/custom/org-access-status/org_456"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      organization: { slug: string };
    };
    expect(body.status).toBe("no-access");
    expect(body.organization.slug).toBe("org_456");
  });
});
