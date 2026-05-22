/**
 * HTTP integration tests for the custom auth routes.
 *
 * Covers:
 *   - /org-access-status/:slug — the shell layout's "you visited an org
 *     you don't belong to" branch (status: member / pending-invite /
 *     auto-domain-join / no-access / not-found / 401).
 *   - /domain-lookup           — onboarding "do any orgs claim my email
 *     domain?" lookup, including the multi-org case where several orgs
 *     have all claimed the same corporate domain.
 *   - /domain-join             — onboarding "join this org" action,
 *     including the new requiresSelection 409 when more than one
 *     auto-join-eligible org exists and the caller didn't pick.
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

// ============================================================================
// /domain-lookup and /domain-join — onboarding auto-join flow.
//
// These tests exercise the multi-org claim path that landed alongside
// migration 091: dropping the UNIQUE on organization_domains.domain lets
// several orgs all claim the same corporate domain. The endpoints have to
// (a) return ALL matching orgs from /domain-lookup so the UI can render a
// picker, and (b) demand an explicit `organizationSlug` from /domain-join
// whenever more than one auto-join-eligible org matches.
// ============================================================================

describe("Onboarding auto-join endpoints", () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);

    __setDbForTesting(database);

    const now = new Date().toISOString();

    // Add a verified corporate user plus two orgs that both claim
    // `acme.test`. Auto-join is enabled on both by default; individual
    // tests flip the flag with raw UPDATEs when they need an "no auto-
    // join" variant. user_solo has no matching claims at all — used by
    // the "no match" and "generic domain" tests.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES ('user_corp', 'corp@acme.test', 1, 'Corp', ${now}, ${now}),
             ('user_solo', 'solo@example.com', 1, 'Solo', ${now}, ${now}),
             ('user_unverified', 'unverified@acme.test', 0, 'Unverified', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    // Two orgs that both claim acme.test with auto-join enabled. The
    // shared seed already created org_1, org_123, and org_456 (slugs:
    // "org_1" / "org_123" / "org_456").
    await sql`
      INSERT INTO organization_domains
        (organization_id, domain, auto_join_enabled, created_at, updated_at)
      VALUES ('org_1', 'acme.test', true, ${now}, ${now}),
             ('org_123', 'acme.test', true, ${now}, ${now})
    `.execute(database.db);

    app = await createApp({ database, eventBus: createMockEventBus() });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    __setDbForTesting(null);
    await closeTestDatabase(database);
  });

  // --------------------------------------------------------------------
  // /domain-lookup
  // --------------------------------------------------------------------

  describe("GET /api/auth/custom/domain-lookup", () => {
    it("returns 401 when unauthenticated", async () => {
      mockSession(null);
      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-lookup"),
      );
      expect(res.status).toBe(401);
    });

    it("returns found:false for an unverified email", async () => {
      mockSession({
        id: "user_unverified",
        email: "unverified@acme.test",
        emailVerified: false,
      });
      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-lookup"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ found: false, organizations: [] });
    });

    it("returns found:false for a generic email domain", async () => {
      mockSession({
        id: "user_solo",
        email: "solo@gmail.com",
        emailVerified: true,
      });
      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-lookup"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ found: false, organizations: [] });
    });

    it("returns found:false when no org claims the domain", async () => {
      mockSession({
        id: "user_solo",
        email: "solo@example.com",
        emailVerified: true,
      });
      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-lookup"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ found: false, organizations: [] });
    });

    it("returns ALL orgs that claim the same domain (multi-org)", async () => {
      mockSession({
        id: "user_corp",
        email: "corp@acme.test",
        emailVerified: true,
      });

      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-lookup"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        found: boolean;
        organizations: Array<{
          id: string;
          slug: string;
          autoJoinEnabled: boolean;
        }>;
      };

      expect(body.found).toBe(true);
      expect(body.organizations).toHaveLength(2);
      // Order isn't part of the contract — compare as sets.
      const slugs = body.organizations.map((o) => o.slug).sort();
      expect(slugs).toEqual(["org_1", "org_123"]);
      expect(body.organizations.every((o) => o.autoJoinEnabled)).toBe(true);
    });

    it("includes orgs whose auto_join_enabled is false (caller decides)", async () => {
      // Flip one org's flag to false. The lookup endpoint should still
      // surface it — the picker's job is to decide what to render based
      // on `autoJoinEnabled` per row, not the server's job to filter.
      await sql`
        UPDATE organization_domains
        SET auto_join_enabled = false
        WHERE organization_id = 'org_123'
      `.execute(database.db);

      mockSession({
        id: "user_corp",
        email: "corp@acme.test",
        emailVerified: true,
      });

      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-lookup"),
      );
      const body = (await res.json()) as {
        organizations: Array<{ slug: string; autoJoinEnabled: boolean }>;
      };
      const byOrg = Object.fromEntries(
        body.organizations.map((o) => [o.slug, o.autoJoinEnabled]),
      );
      expect(byOrg).toEqual({ org_1: true, org_123: false });
    });
  });

  // --------------------------------------------------------------------
  // /domain-join
  // --------------------------------------------------------------------

  describe("POST /api/auth/custom/domain-join", () => {
    /** Stub `auth.api.addMember` with a direct INSERT into `member` so the
     *  test can later assert membership without wiring the full Better
     *  Auth adapter. Returns the spy so individual tests can inspect
     *  call args. */
    function stubAddMember() {
      return vi
        .spyOn(auth.api, "addMember")
        .mockImplementation(async (args: unknown) => {
          const { body } = args as {
            body: { userId: string; organizationId: string; role: string };
          };
          const now = new Date().toISOString();
          await sql`
            INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
            VALUES (
              ${"mem_" + body.userId + "_" + body.organizationId},
              ${body.userId},
              ${body.organizationId},
              ${body.role},
              ${now}
            )
            ON CONFLICT (id) DO NOTHING
          `.execute(database.db);
          return {} as never;
        });
    }

    async function isMember(userId: string, orgId: string): Promise<boolean> {
      const row = await database.db
        .selectFrom("member")
        .select(["id"])
        .where("userId", "=", userId)
        .where("organizationId", "=", orgId)
        .executeTakeFirst();
      return !!row;
    }

    it("returns 401 when unauthenticated", async () => {
      mockSession(null);
      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 403 for unverified email", async () => {
      mockSession({
        id: "user_unverified",
        email: "unverified@acme.test",
        emailVerified: false,
      });
      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(403);
    });

    it("returns 403 for a generic email domain", async () => {
      mockSession({
        id: "user_solo",
        email: "solo@gmail.com",
        emailVerified: true,
      });
      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(403);
    });

    it("returns 403 when no org claims the domain with auto-join", async () => {
      // Disable auto-join on both claims for this scenario.
      await sql`
        UPDATE organization_domains SET auto_join_enabled = false
        WHERE domain = 'acme.test'
      `.execute(database.db);

      mockSession({
        id: "user_corp",
        email: "corp@acme.test",
        emailVerified: true,
      });
      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(403);
    });

    it("joins the only auto-join-eligible org when slug is omitted", async () => {
      // Leave only org_1 with auto-join enabled.
      await sql`
        UPDATE organization_domains SET auto_join_enabled = false
        WHERE organization_id = 'org_123'
      `.execute(database.db);

      const addMember = stubAddMember();
      mockSession({
        id: "user_corp",
        email: "corp@acme.test",
        emailVerified: true,
      });

      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; slug: string };
      expect(body.success).toBe(true);
      expect(body.slug).toBe("org_1");
      expect(addMember).toHaveBeenCalledTimes(1);
      expect(await isMember("user_corp", "org_1")).toBe(true);
    });

    it("returns 409 requiresSelection when multiple orgs match and no slug is given", async () => {
      // Both orgs already auto-join eligible from beforeEach.
      const addMember = stubAddMember();
      mockSession({
        id: "user_corp",
        email: "corp@acme.test",
        emailVerified: true,
      });

      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        success: boolean;
        requiresSelection?: boolean;
      };
      expect(body.success).toBe(false);
      expect(body.requiresSelection).toBe(true);
      expect(addMember).not.toHaveBeenCalled();
      // No membership row should have been written.
      expect(await isMember("user_corp", "org_1")).toBe(false);
      expect(await isMember("user_corp", "org_123")).toBe(false);
    });

    it("joins the specific org when caller picks a slug from a multi-org match", async () => {
      const addMember = stubAddMember();
      mockSession({
        id: "user_corp",
        email: "corp@acme.test",
        emailVerified: true,
      });

      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationSlug: "org_123" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; slug: string };
      expect(body.success).toBe(true);
      expect(body.slug).toBe("org_123");
      expect(addMember).toHaveBeenCalledTimes(1);
      const addArgs = addMember.mock.calls[0]![0] as {
        body: { organizationId: string };
      };
      expect(addArgs.body.organizationId).toBe("org_123");
      // The OTHER eligible org must NOT have been joined.
      expect(await isMember("user_corp", "org_123")).toBe(true);
      expect(await isMember("user_corp", "org_1")).toBe(false);
    });

    it("returns 403 when the picked slug does not claim the caller's domain", async () => {
      // org_456 exists (seeded) but doesn't claim acme.test.
      const addMember = stubAddMember();
      mockSession({
        id: "user_corp",
        email: "corp@acme.test",
        emailVerified: true,
      });

      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationSlug: "org_456" }),
        }),
      );
      expect(res.status).toBe(403);
      expect(addMember).not.toHaveBeenCalled();
      expect(await isMember("user_corp", "org_456")).toBe(false);
    });

    it("returns 403 when the picked slug is auto-join-disabled, even if it claims the domain", async () => {
      // Turn off auto-join for the org the caller is trying to pick.
      await sql`
        UPDATE organization_domains SET auto_join_enabled = false
        WHERE organization_id = 'org_123'
      `.execute(database.db);

      const addMember = stubAddMember();
      mockSession({
        id: "user_corp",
        email: "corp@acme.test",
        emailVerified: true,
      });

      const res = await app.fetch(
        new Request("http://test/api/auth/custom/domain-join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationSlug: "org_123" }),
        }),
      );
      expect(res.status).toBe(403);
      expect(addMember).not.toHaveBeenCalled();
    });
  });
});
