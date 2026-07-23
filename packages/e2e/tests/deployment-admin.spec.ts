/**
 * E2E coverage for the deployment-admin dashboard (/api/_admin/*).
 *
 * Unlike every other spec, this one can't mint a fresh per-test principal
 * for the ADMIN side: DEPLOYMENT_ADMIN_EMAILS (playwright.config.ts) is
 * process-wide config, so every test that needs to act as a deployment admin
 * must sign in as the same fixed, reserved email. That shared identity is
 * safe to reuse across fresh APIRequestContexts (each sign-in gets its own
 * session), but its `emailVerified` flag is a single mutable row every test
 * would otherwise race on under `fullyParallel`. Running the API describe
 * `serial` removes that race — see TESTING.md's tenant-scoping doctrine for
 * why every OTHER spec instead mints a fresh org/user/thread per test.
 *
 * Serial mode is also load-bearing for ORDERING, not just the emailVerified
 * race: grantDeploymentAdmin is a per-process, push-only grant, so whether a
 * fellow admin can be impersonated flips permanently the first time that
 * admin's identity passes requireDeploymentAdmin. The 409 test (pre-grant:
 * impersonation succeeds) must run before the FORBIDDEN test (post-grant:
 * better-auth refuses) — serial makes that deterministic.
 *
 * This spec is also the upgrade canary for the adminUserIds mechanism — see
 * the comment on `deploymentAdminUserIds` in apps/api/src/auth/index.ts.
 *
 * The impersonation *exit* path is covered at the API level (stop-impersonating
 * below); the amber "Impersonating" pill is client-only presentation, currently
 * uncovered (a popover-drive here would be flaky; a component test would fit).
 */
import type { APIRequestContext } from "@playwright/test";
import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi, TEST_PASSWORD } from "../fixtures/auth-api";
import { expect, getE2EAppOrigin, newApiContext, test } from "../fixtures/test";

const DEPLOYMENT_ADMIN_EMAIL = "deployment-admin@e2e.local";
// Second allowlisted admin (see playwright.config.ts) — impersonating THIS
// verified admin is what lets the re-impersonation test reach the 409 guard.
const DEPLOYMENT_ADMIN_EMAIL_2 = "deployment-admin-2@e2e.local";
// The sign-in fallback below must use the same password sign-up used when an
// earlier `reuseExistingServer` run created the identity.
const DEPLOYMENT_ADMIN_PASSWORD = TEST_PASSWORD;

/** Idempotent: signs up the reserved admin identity, or signs in if a prior
 *  `reuseExistingServer` run already created it. */
async function ensureDeploymentAdmin(
  request: APIRequestContext,
  email: string = DEPLOYMENT_ADMIN_EMAIL,
): Promise<{ userId: string }> {
  const signUpRes = await request.post("/api/auth/sign-up/email", {
    data: {
      email,
      password: DEPLOYMENT_ADMIN_PASSWORD,
      name: "Deployment Admin",
    },
  });
  if (signUpRes.ok()) {
    const body = (await signUpRes.json()) as { user?: { id?: string } };
    const userId = body.user?.id;
    if (!userId) {
      throw new Error(
        "ensureDeploymentAdmin: sign-up response missing user.id",
      );
    }
    return { userId };
  }

  const signInRes = await request.post("/api/auth/sign-in/email", {
    data: {
      email,
      password: DEPLOYMENT_ADMIN_PASSWORD,
    },
  });
  if (!signInRes.ok()) {
    const body = await signInRes.text().catch(() => "<unreadable>");
    throw new Error(
      `ensureDeploymentAdmin: sign-up and sign-in fallback both failed — HTTP ${signInRes.status()} — ${body}`,
    );
  }
  const body = (await signInRes.json()) as { user?: { id?: string } };
  const userId = body.user?.id;
  if (!userId) {
    throw new Error("ensureDeploymentAdmin: sign-in response missing user.id");
  }
  return { userId };
}

/** The admin's own emailVerified flag is shared mutable state (see file
 *  header) — every test that needs a verified admin re-asserts it itself. */
async function verifyDeploymentAdmin(db: Client, userId: string) {
  await db.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [
    userId,
  ]);
}

test.describe("/api/_admin/*", () => {
  test.describe.configure({ mode: "serial" });

  let db: Client;

  test.beforeAll(async ({ playwright }) => {
    db = await connectDevDb();
    // Fail fast with a pointed message when the app server wasn't started
    // with DEPLOYMENT_ADMIN_EMAILS — easy under reuseExistingServer (a plain
    // dev server predating this suite's env). Without this, every test below
    // fails as an opaque 403.
    const probe = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(probe);
    await verifyDeploymentAdmin(db, admin.userId);
    const me = await probe.get("/api/_admin/me");
    await probe.dispose();
    if (me.status() === 403) {
      throw new Error(
        "GET /api/_admin/me → 403 for the reserved admin: the app server is " +
          "missing DEPLOYMENT_ADMIN_EMAILS. Restart it with the env from " +
          "playwright.config.ts, or stop reusing the existing server.",
      );
    }
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("anonymous is rejected", async ({ playwright }) => {
    const anon = await newApiContext(playwright);
    const res = await anon.get("/api/_admin/me");
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test("a verified but non-allowlisted user is forbidden", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);
    await verifyDeploymentAdmin(db, user.userId);
    const res = await ctx.get("/api/_admin/me");
    expect(res.status()).toBe(403);
    await ctx.dispose();
  });

  test("an UNVERIFIED non-allowlisted user gets a plain 403, not the verification hint", async ({
    playwright,
  }) => {
    // Pins the check ORDER in requireDeploymentAdmin: allowlist before
    // emailVerified. Swapped, a random unverified signup would get the 401
    // email_not_verified hint — leaking "this email would be an admin if
    // verified" semantics to anyone. The verified variant above can't catch
    // that; both orderings return 403 for it.
    const ctx = await newApiContext(playwright);
    await signUpViaApi(ctx); // fresh signups are unverified
    const res = await ctx.get("/api/_admin/me");
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe("email_not_verified");
    await ctx.dispose();
  });

  test("the raw better-auth admin surface is fenced off", async ({
    playwright,
  }) => {
    // An allowlisted, verified admin must NOT be able to reach the raw admin
    // plugin (set-role etc.) — only stop-impersonating is allowed through.
    // Otherwise a pushed adminUserIds id could mint a persistent admin.
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);
    // Establish the threat precondition the fence exists for: the admin id is
    // actually IN adminUserIds (granted on this /me pass), so the probes below
    // prove the fence blocks a GRANTED id, not just an unknown one.
    const me = await adminCtx.get("/api/_admin/me");
    expect(me.status()).toBe(200);

    // Cover a representative spread of the admin plugin (mixed methods): a
    // path- or method-specific refactor of the fence could pass a single-route
    // check while reopening the others. impersonate-user matters most — it's
    // the one that would bypass the audited /api/_admin/impersonate wrapper.
    const fenced: Array<{ path: string; method: "get" | "post" }> = [
      { path: "set-role", method: "post" },
      { path: "set-user-password", method: "post" },
      { path: "create-user", method: "post" },
      { path: "ban-user", method: "post" },
      { path: "remove-user", method: "post" },
      { path: "update-user", method: "post" },
      { path: "impersonate-user", method: "post" },
      { path: "list-users", method: "get" },
    ];
    for (const { path, method } of fenced) {
      const url = `/api/auth/admin/${path}`;
      const res =
        method === "get" ? await adminCtx.get(url) : await adminCtx.post(url);
      expect(
        res.status(),
        `${method.toUpperCase()} ${path} must be fenced`,
      ).toBe(404);
    }
    await adminCtx.dispose();
  });

  test("mutating admin routes reject an untrusted Origin (CSRF hardening)", async ({
    playwright,
  }) => {
    // The SameSite=Lax cookie is what blocks cross-site POSTs today, but the
    // routes also check Origin explicitly so a future cookie-config change
    // (e.g. SameSite=None for cross-subdomain deploys) can't silently reopen
    // instance-wide CSRF. A forged Origin must lose even with a valid session.
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const res = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: admin.userId },
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status()).toBe(403);

    // GETs are reads, not CSRF targets — still served.
    const read = await adminCtx.get("/api/_admin/me", {
      headers: { Origin: "https://evil.example" },
    });
    expect(read.status()).toBe(200);

    await adminCtx.dispose();
  });

  test("allowlisted admin: email_not_verified pre-verification, ok post-flip", async ({
    playwright,
  }) => {
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);

    // Force the "not yet verified" state regardless of prior runs.
    await db.query(`UPDATE "user" SET "emailVerified" = false WHERE id = $1`, [
      admin.userId,
    ]);
    const before = await adminCtx.get("/api/_admin/me");
    expect(before.status()).toBe(401);
    expect(((await before.json()) as { error?: string }).error).toBe(
      "email_not_verified",
    );

    await verifyDeploymentAdmin(db, admin.userId);
    const after = await adminCtx.get("/api/_admin/me");
    expect(after.status()).toBe(200);
    expect(((await after.json()) as { email?: string }).email).toBe(
      DEPLOYMENT_ADMIN_EMAIL,
    );

    await adminCtx.dispose();
  });

  test("GET /users finds a per-test target via searchValue", async ({
    playwright,
  }) => {
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const targetCtx = await newApiContext(playwright);
    const target = await signUpViaApi(targetCtx);

    const res = await adminCtx.get(
      `/api/_admin/users?searchValue=${encodeURIComponent(target.email)}`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ id: string; email: string }>;
    };
    const targetRow = body.users.find((u) => u.id === target.userId);
    expect(targetRow).toBeTruthy();
    // Pin the wire contract: the handler projects to exactly these fields so
    // admin-plugin columns (role, banned, banReason, ...) never leak. A
    // regression to raw better-auth passthrough must fail here.
    expect(Object.keys(targetRow as object).sort()).toEqual([
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "image",
      "name",
    ]);

    // The search merges an email probe and a NAME probe (better-auth searches
    // one field per call) — prove the name half works. Test names are unique
    // per run ("T<suffix> User"), so the first word is a precise needle.
    const nameNeedle = target.name.split(" ")[0];
    const byName = await adminCtx.get(
      `/api/_admin/users?searchValue=${encodeURIComponent(nameNeedle)}`,
    );
    expect(byName.status()).toBe(200);
    const byNameBody = (await byName.json()) as {
      users: Array<{ id: string }>;
    };
    expect(byNameBody.users.some((u) => u.id === target.userId)).toBe(true);

    // limit is clamped and honored (there are ≥2 users by this point).
    const limited = await adminCtx.get("/api/_admin/users?limit=1");
    expect(limited.status()).toBe(200);
    const limitedBody = (await limited.json()) as { users: unknown[] };
    expect(limitedBody.users.length).toBe(1);

    await adminCtx.dispose();
    await targetCtx.dispose();
  });

  test("impersonate switches the session, stopImpersonating restores it", async ({
    playwright,
  }) => {
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const targetCtx = await newApiContext(playwright);
    const target = await signUpViaApi(targetCtx);

    const impersonateRes = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: target.userId },
    });
    expect(impersonateRes.ok()).toBe(true);

    const impersonated = await adminCtx.get("/api/auth/get-session");
    const impersonatedBody = (await impersonated.json()) as {
      user: { id: string };
      session: { impersonatedBy?: string };
    };
    expect(impersonatedBody.user.id).toBe(target.userId);
    expect(impersonatedBody.session.impersonatedBy).toBe(admin.userId);

    // The endpoint the AccountPopover's "Stop impersonation" button calls —
    // still reachable despite the /api/auth/admin/* fence.
    const stopRes = await adminCtx.post("/api/auth/admin/stop-impersonating");
    expect(stopRes.ok()).toBe(true);

    const restored = await adminCtx.get("/api/auth/get-session");
    const restoredBody = (await restored.json()) as { user: { id: string } };
    expect(restoredBody.user.id).toBe(admin.userId);

    await adminCtx.dispose();
    await targetCtx.dispose();
  });

  test("impersonate validates input: missing 400, unknown 404, re-impersonate rejected", async ({
    playwright,
  }) => {
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const missing = await adminCtx.post("/api/_admin/impersonate", {
      data: {},
    });
    expect(missing.status()).toBe(400);

    const unknown = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: `nonexistent-${Date.now()}` },
    });
    expect(unknown.status()).toBe(404);

    // Self-impersonation is rejected server-side, not just disabled in the UI.
    const self = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: admin.userId },
    });
    expect(self.status()).toBe(400);

    // Impersonate a normal user, then try again: requireDeploymentAdmin rejects
    // the second call because the session is now the target — 401 if the target
    // is unverified (fresh e2e signups are), 403 if verified-but-not-allowlisted.
    // Either way the middleware blocks it before the 409 guard, and it's never
    // allowed through (200) — that's the invariant that matters.
    const targetCtx = await newApiContext(playwright);
    const target = await signUpViaApi(targetCtx);
    const first = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: target.userId },
    });
    expect(first.ok()).toBe(true);
    const second = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: target.userId },
    });
    expect([401, 403]).toContain(second.status());

    await adminCtx.post("/api/auth/admin/stop-impersonating");
    await adminCtx.dispose();
    await targetCtx.dispose();
  });

  test("re-impersonating (admin impersonating an admin) hits the 409 restore-cookie guard", async ({
    playwright,
  }) => {
    // The non-admin re-impersonate test above is stopped by the middleware
    // before the handler's 409 runs. To exercise the 409 itself — the guard
    // that stops the admin_session restore cookie from being clobbered — the
    // impersonated session must still pass requireDeploymentAdmin, i.e. the
    // target must itself be a verified, allowlisted admin.
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const admin2Ctx = await newApiContext(playwright);
    const admin2 = await ensureDeploymentAdmin(
      admin2Ctx,
      DEPLOYMENT_ADMIN_EMAIL_2,
    );
    await verifyDeploymentAdmin(db, admin2.userId);

    const first = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: admin2.userId },
    });
    if (first.status() === 403) {
      // Reused server process (local reuseExistingServer rerun): a previous
      // run already pushed admin2 into adminUserIds, so better-auth refuses
      // to impersonate them at all — the post-grant behavior the NEXT test
      // pins deterministically. The 409 guard is only reachable pre-grant,
      // i.e. once per server process.
      await adminCtx.dispose();
      await admin2Ctx.dispose();
      return;
    }
    expect(first.ok()).toBe(true);

    // Session is now admin2 (allowlisted+verified) → middleware passes → the
    // handler's "already impersonating" guard is what rejects, with 409.
    const second = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: admin.userId },
    });
    expect(second.status()).toBe(409);

    await adminCtx.post("/api/auth/admin/stop-impersonating");
    await adminCtx.dispose();
    await admin2Ctx.dispose();
  });

  test("a granted fellow admin cannot be impersonated (blocked, not silent)", async ({
    playwright,
  }) => {
    // grantDeploymentAdmin is lazy: an allowlisted admin enters adminUserIds
    // the first time they pass requireDeploymentAdmin, and better-auth then
    // refuses to impersonate them (allowImpersonatingAdmins is deliberately
    // off). The previous test proved the pre-grant order; this one forces the
    // grant and pins the post-grant order, so the timing-dependent behavior
    // is documented in both directions. Serial mode makes the order real.
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const admin2Ctx = await newApiContext(playwright);
    const admin2 = await ensureDeploymentAdmin(
      admin2Ctx,
      DEPLOYMENT_ADMIN_EMAIL_2,
    );
    await verifyDeploymentAdmin(db, admin2.userId);
    // Force the grant: admin2's own identity passes requireDeploymentAdmin.
    const me2 = await admin2Ctx.get("/api/_admin/me");
    expect(me2.status()).toBe(200);

    const res = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: admin2.userId },
    });
    expect(res.status()).toBe(403);

    await adminCtx.dispose();
    await admin2Ctx.dispose();
  });

  test("add member: success, duplicate 409, unknown email 404, bad role 400", async ({
    playwright,
  }) => {
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgRow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [owner.orgSlug],
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new Error("Org not found after signup");

    const targetCtx = await newApiContext(playwright);
    const target = await signUpViaApi(targetCtx);

    const addRes = await adminCtx.post(`/api/_admin/orgs/${orgId}/members`, {
      data: { email: target.email, role: "admin" },
    });
    expect(addRes.status()).toBe(200);

    const memberRow = await db.query<{ role: string }>(
      `SELECT role FROM "member" WHERE "organizationId" = $1 AND "userId" = $2`,
      [orgId, target.userId],
    );
    expect(memberRow.rows[0]?.role).toBe("admin");

    const dupRes = await adminCtx.post(`/api/_admin/orgs/${orgId}/members`, {
      data: { email: target.email, role: "admin" },
    });
    expect(dupRes.status()).toBe(409);

    const unknownRes = await adminCtx.post(
      `/api/_admin/orgs/${orgId}/members`,
      {
        data: { email: `nobody-${Date.now()}@e2e.local`, role: "admin" },
      },
    );
    expect(unknownRes.status()).toBe(404);

    const badRoleRes = await adminCtx.post(
      `/api/_admin/orgs/${orgId}/members`,
      {
        data: { email: target.email, role: "superadmin" },
      },
    );
    expect(badRoleRes.status()).toBe(400);

    await adminCtx.dispose();
    await ownerCtx.dispose();
    await targetCtx.dispose();
  });

  test("add member to a nonexistent org is a 4xx, not a 500", async ({
    playwright,
  }) => {
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const targetCtx = await newApiContext(playwright);
    const target = await signUpViaApi(targetCtx);

    // better-auth throws ORGANIZATION_NOT_FOUND; handleApiError maps it to its
    // real status instead of flattening the thrown APIError to a 500.
    const res = await adminCtx.post(
      `/api/_admin/orgs/nonexistent-org-id/members`,
      { data: { email: target.email, role: "user" } },
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);

    await adminCtx.dispose();
    await targetCtx.dispose();
  });

  test("GET /orgs lists an org with its member count", async ({
    playwright,
  }) => {
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    const res = await adminCtx.get("/api/_admin/orgs");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      organizations: Array<{ slug: string; memberCount: number }>;
    };
    const org = body.organizations.find((o) => o.slug === owner.orgSlug);
    expect(org).toBeTruthy();
    expect(org?.memberCount).toBeGreaterThanOrEqual(1);

    // Slug search: a hit narrows to the org, a nonsense needle finds nothing.
    const hit = await adminCtx.get(
      `/api/_admin/orgs?search=${encodeURIComponent(owner.orgSlug)}`,
    );
    const hitBody = (await hit.json()) as {
      organizations: Array<{ slug: string }>;
    };
    expect(hitBody.organizations.some((o) => o.slug === owner.orgSlug)).toBe(
      true,
    );
    const miss = await adminCtx.get(
      `/api/_admin/orgs?search=no-such-org-${Date.now()}`,
    );
    expect(
      ((await miss.json()) as { organizations: unknown[] }).organizations,
    ).toHaveLength(0);

    // limit is clamped and honored (≥2 orgs exist: admin's + owner's).
    const limited = await adminCtx.get("/api/_admin/orgs?limit=1");
    expect(
      ((await limited.json()) as { organizations: unknown[] }).organizations,
    ).toHaveLength(1);

    await adminCtx.dispose();
    await ownerCtx.dispose();
  });

  test("the SSO-enforcement middleware exempts /api/_admin/*", async ({
    playwright,
  }) => {
    // Regression guard for the ADMIN_API_PREFIX exemption in app.ts: an org
    // with `enforced` SSO 403s its members' org-context API calls, but the
    // instance-level admin surface is not governed by any single org's SSO
    // policy — an admin whose ACTIVE org enforces SSO must keep dashboard
    // access (the UI would otherwise read the 403 as "not an admin").
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const orgRow = await db.query<{ organizationId: string }>(
      `SELECT "organizationId" FROM "member" WHERE "userId" = $1 LIMIT 1`,
      [admin.userId],
    );
    const orgId = orgRow.rows[0]?.organizationId;
    if (!orgId) throw new Error("Admin has no org membership");

    // The enforcement middleware reads the org off the session, so make this
    // session's active org the one we're about to enforce.
    const setActive = await adminCtx.post("/api/auth/organization/set-active", {
      data: { organizationId: orgId },
    });
    expect(setActive.ok()).toBe(true);

    await db.query(
      `DELETE FROM "org_sso_config" WHERE "organization_id" = $1`,
      [orgId],
    );
    await db.query(
      `INSERT INTO "org_sso_config"
         (id, organization_id, issuer, client_id, client_secret, scopes,
          domain, enforced, created_at, updated_at)
       VALUES ($1, $2, 'https://sso.e2e.local', 'e2e-client', 'not-decryptable',
               '["openid"]', 'e2e.local', 1, $3, $3)`,
      [crypto.randomUUID(), orgId, new Date().toISOString()],
    );

    try {
      // Enforcement is live for this principal: a non-exempt API path is
      // blocked. 403 is the clean enforcement answer; 500 means the middleware
      // consulted the seeded config (the vault can't decrypt the fixture
      // secret) — either proves the middleware fired, where an exempt or
      // unenforced path would fall through to the 404 handler.
      const blocked = await adminCtx.get("/api/e2e-sso-enforcement-probe");
      expect([403, 500]).toContain(blocked.status());

      // The exemption: the admin surface stays reachable.
      const me = await adminCtx.get("/api/_admin/me");
      expect(me.status()).toBe(200);
    } finally {
      await db.query(
        `DELETE FROM "org_sso_config" WHERE "organization_id" = $1`,
        [orgId],
      );
    }

    await adminCtx.dispose();
  });

  test("a verified admin sees the dashboard in a browser", async ({
    browser,
  }) => {
    const baseURL = getE2EAppOrigin();
    // Origin header so the sign-in POST clears Better Auth's CSRF guard — same
    // reason newApiContext sets it for standalone API contexts.
    const ctx = await browser.newContext({
      baseURL,
      extraHTTPHeaders: { Origin: baseURL },
    });
    const page = await ctx.newPage();
    const admin = await ensureDeploymentAdmin(page.context().request);
    await verifyDeploymentAdmin(db, admin.userId);

    await page.goto("/_admin");
    await expect(
      page.getByRole("heading", { name: "Admin Dashboard" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible();

    // The index route redirects to the users tab; a broken redirect renders a
    // blank outlet under a green heading.
    await expect(page).toHaveURL(/\/_admin\/users/);

    // The initial (no-search) GET /api/_admin/users parsed and rendered rows —
    // the Impersonate button renders once per user row.
    await expect(
      page.getByRole("button", { name: "Impersonate" }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Search reaches the API and finds a known row (the admin itself — the
    // unsearched first page can't be asserted on a long-lived dev DB).
    await page
      .getByPlaceholder("Search users by email or name...")
      .fill(DEPLOYMENT_ADMIN_EMAIL);
    await expect(page.getByText(DEPLOYMENT_ADMIN_EMAIL).first()).toBeVisible({
      timeout: 15_000,
    });

    await ctx.close();
  });
});

test.describe("deployment-admin dashboard (browser gate)", () => {
  test("a non-admin visiting /_admin sees the restricted gate", async ({
    authedPage,
  }) => {
    const { page } = authedPage;
    await page.goto("/_admin");
    await expect(
      page.getByText("This dashboard is restricted to deployment admins."),
    ).toBeVisible({ timeout: 15_000 });
  });
});
