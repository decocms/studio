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
 * This spec is also the upgrade canary for the adminUserIds mechanism — see
 * the comment on `deploymentAdminUserIds` in apps/mesh/src/auth/index.ts.
 *
 * The impersonation *exit* path is covered at the API level (stop-impersonating
 * below); the amber "Impersonating" pill is client-only presentation left to a
 * component test rather than a flaky popover-drive here.
 */
import type { APIRequestContext } from "@playwright/test";
import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, getE2EAppOrigin, newApiContext, test } from "../fixtures/test";

const DEPLOYMENT_ADMIN_EMAIL = "deployment-admin@e2e.local";
// Matches generateTestUser's fixed password in fixtures/auth-api.ts, so the
// sign-in fallback below succeeds against a user created by an earlier run.
const DEPLOYMENT_ADMIN_PASSWORD = "Playwright123!";

/** Idempotent: signs up the reserved admin identity, or signs in if a prior
 *  `reuseExistingServer` run already created it. */
async function ensureDeploymentAdmin(
  request: APIRequestContext,
): Promise<{ userId: string }> {
  const signUpRes = await request.post("/api/auth/sign-up/email", {
    data: {
      email: DEPLOYMENT_ADMIN_EMAIL,
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
      email: DEPLOYMENT_ADMIN_EMAIL,
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

  test.beforeAll(async () => {
    db = await connectDevDb();
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

  test("the raw better-auth admin surface is fenced off", async ({
    playwright,
  }) => {
    // An allowlisted, verified admin must NOT be able to reach the raw admin
    // plugin (set-role etc.) — only stop-impersonating is allowed through.
    // Otherwise a pushed adminUserIds id could mint a persistent admin.
    const adminCtx = await newApiContext(playwright);
    const admin = await ensureDeploymentAdmin(adminCtx);
    await verifyDeploymentAdmin(db, admin.userId);

    const setRole = await adminCtx.post("/api/auth/admin/set-role", {
      data: { userId: admin.userId, role: "admin" },
    });
    expect(setRole.status()).toBe(404);
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
    expect(body.users.some((u) => u.id === target.userId)).toBe(true);

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

  test("impersonate validates input: missing 400, unknown 404, re-impersonate 403", async ({
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

    // Impersonate a normal user, then try again: the middleware rejects the
    // second call (the session is now the non-allowlisted target) before the
    // 409 guard is ever reached — this is the contract a real admin hits.
    const targetCtx = await newApiContext(playwright);
    const target = await signUpViaApi(targetCtx);
    const first = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: target.userId },
    });
    expect(first.ok()).toBe(true);
    const second = await adminCtx.post("/api/_admin/impersonate", {
      data: { userId: target.userId },
    });
    expect(second.status()).toBe(403);

    await adminCtx.post("/api/auth/admin/stop-impersonating");
    await adminCtx.dispose();
    await targetCtx.dispose();
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

    await adminCtx.dispose();
    await ownerCtx.dispose();
  });

  test("a verified admin sees the dashboard in a browser", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ baseURL: getE2EAppOrigin() });
    const page = await ctx.newPage();
    const admin = await ensureDeploymentAdmin(page.context().request);
    await verifyDeploymentAdmin(db, admin.userId);

    await page.goto("/_admin");
    await expect(
      page.getByRole("heading", { name: "Admin Dashboard" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible();

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
