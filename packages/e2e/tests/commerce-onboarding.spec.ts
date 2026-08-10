import { type Page } from "@playwright/test";
import { sleep } from "@decocms/shared/std";
import { type Client } from "pg";
import { signUpViaApi } from "../fixtures/auth-api";
import { signUp } from "../fixtures/auth";
import { connectDevDb } from "../fixtures/db";
import { expect, test } from "../fixtures/test";

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const TEST_DOMAIN = `commerce-e2e-${RUN_ID}.test`;
const ORG_A_ID = `e2e_commerce_org_a_${RUN_ID}`;
const ORG_B_ID = `e2e_commerce_org_b_${RUN_ID}`;
const ORG_A_SLUG = `e2e-commerce-a-${RUN_ID}`;
const ORG_B_SLUG = `e2e-commerce-b-${RUN_ID}`;
const ORG_A_NAME = `Commerce E2E A ${RUN_ID}`;
const ORG_B_NAME = `Commerce E2E B ${RUN_ID}`;
const MIXED_AUTO_ORG_ID = `e2e_commerce_mixed_auto_${RUN_ID}`;
const MIXED_REQUEST_ORG_ID = `e2e_commerce_mixed_request_${RUN_ID}`;
const ONBOARDING_ARCHIVED_ORG_ID = `e2e_commerce_onboarding_archived_${RUN_ID}`;
const SEEDED_ORG_IDS = [
  ORG_A_ID,
  ORG_B_ID,
  `e2e_commerce_join_${RUN_ID}`,
  `e2e_commerce_archived_${RUN_ID}`,
  MIXED_AUTO_ORG_ID,
  MIXED_REQUEST_ORG_ID,
  ONBOARDING_ARCHIVED_ORG_ID,
];
const PASSWORD = "Playwright123!";
const commerceDiscoveryOrgIds = new Set<string>();

function uniqueEmail(prefix: string, domain = "playwright.local") {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@${domain}`;
}

function domainToSlug(domain: string) {
  return domain
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function commerceDiscoveryConnectionId(orgId: string) {
  return `${orgId}_commerce-discovery`;
}

function commerceDiscoveryVirtualMcpId(orgId: string) {
  return `commerce-discovery_${orgId}`;
}

async function signUpOnCurrentLoginPage(page: Page, email: string) {
  const nameField = page.getByPlaceholder(/Your name|Seu nome/);
  const inSignupMode = await nameField
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!inSignupMode) {
    await page
      .getByRole("button", { name: /^(Sign up|Create account|Criar conta)$/ })
      .click();
    await nameField.waitFor({ state: "visible" });
  }

  await nameField.fill(`Commerce ${Date.now()}`);
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("••••••••").fill(PASSWORD);
  await page.getByRole("button", { name: /^(Continue|Continuar)$/ }).click();
}

async function waitForConnection(db: Client, id: string) {
  await expect
    .poll(async () => {
      const row = await db.query<{
        id: string;
        connection_url: string | null;
        connection_type: string;
        title: string;
      }>(
        `SELECT id, connection_url, connection_type, title
         FROM connections
         WHERE id = $1`,
        [id],
      );
      return row.rows[0] ?? null;
    })
    .not.toBeNull();
}

async function findUserId(db: Client, email: string): Promise<string> {
  const userRow = await db.query<{ id: string }>(
    `SELECT id FROM "user" WHERE email = $1`,
    [email],
  );
  const userId = userRow.rows[0]?.id;
  if (!userId) {
    throw new Error(`Test user ${email} not found in DB after signup`);
  }
  return userId;
}

async function verifyUserAndClearMembership(db: Client, userId: string) {
  await db.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [
    userId,
  ]);
  await db.query(`DELETE FROM "member" WHERE "userId" = $1`, [userId]);
}

async function orgIdForSlug(db: Client, slug: string): Promise<string> {
  const orgRow = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const orgId = orgRow.rows[0]?.id;
  if (!orgId) {
    throw new Error(`Organization ${slug} not found`);
  }
  return orgId;
}

async function orgIdsForUser(db: Client, userId: string): Promise<string[]> {
  const memberRows = await db.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM "member" WHERE "userId" = $1`,
    [userId],
  );
  return memberRows.rows.map((row) => row.organizationId);
}

async function trackCommerceDiscoveryOrgForSlug(db: Client, slug: string) {
  const orgId = await orgIdForSlug(db, slug);
  commerceDiscoveryOrgIds.add(orgId);
  return orgId;
}

async function seedDomainOrg(
  db: Client,
  input: {
    id: string;
    name: string;
    slug: string;
    domain: string;
    joinMode?: "auto" | "request";
    archived?: boolean;
  },
) {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO "organization" (id, name, slug, metadata, "createdAt")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.id,
      input.name,
      input.slug,
      input.archived ? JSON.stringify({ archived: true }) : null,
      now,
    ],
  );
  await db.query(
    `INSERT INTO organization_domains
       (id, organization_id, domain, join_mode, verification_status,
        verification_method, verified_at, created_at, updated_at)
     VALUES
       (gen_random_uuid()::text, $1, $2, $4, 'verified', 'email', $3, $3, $3)
     ON CONFLICT (organization_id, domain) DO UPDATE
       SET join_mode = EXCLUDED.join_mode,
           verification_status = EXCLUDED.verification_status,
           updated_at = EXCLUDED.updated_at`,
    [input.id, input.domain, now, input.joinMode ?? "auto"],
  );
}

test.describe("Commerce onboarding route isolation", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, $7), ($4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A_ID, ORG_A_NAME, ORG_A_SLUG, ORG_B_ID, ORG_B_NAME, ORG_B_SLUG, now],
    );

    await db.query(
      `INSERT INTO organization_domains
         (id, organization_id, domain, join_mode, verification_status,
          verification_method, verified_at, created_at, updated_at)
       VALUES
         (gen_random_uuid()::text, $1, $3, 'auto', 'verified', 'email', $4, $4, $4),
         (gen_random_uuid()::text, $2, $3, 'auto', 'verified', 'email', $4, $4, $4)
       ON CONFLICT (organization_id, domain) DO UPDATE
         SET join_mode = EXCLUDED.join_mode,
             verification_status = EXCLUDED.verification_status,
             updated_at = EXCLUDED.updated_at`,
      [ORG_A_ID, ORG_B_ID, TEST_DOMAIN, now],
    );
  });

  test.afterAll(async () => {
    if (!db) return;

    const commerceDiscoveryConnectionIds = [...commerceDiscoveryOrgIds].flatMap(
      (orgId) => [
        commerceDiscoveryConnectionId(orgId),
        commerceDiscoveryVirtualMcpId(orgId),
      ],
    );

    if (commerceDiscoveryConnectionIds.length > 0) {
      await db.query(
        `DELETE FROM connection_aggregations
         WHERE parent_connection_id = ANY($1::text[])
            OR child_connection_id = ANY($1::text[])`,
        [commerceDiscoveryConnectionIds],
      );
      await db.query(`DELETE FROM connections WHERE id = ANY($1::text[])`, [
        commerceDiscoveryConnectionIds,
      ]);
    }

    await db.query(`DELETE FROM organization_domains WHERE domain LIKE $1`, [
      `commerce-e2e-${RUN_ID}%`,
    ]);
    await db.query(
      `DELETE FROM "member"
       WHERE "organizationId" = ANY($1::text[])`,
      [SEEDED_ORG_IDS],
    );
    await db.query(`DELETE FROM "organization" WHERE id = ANY($1::text[])`, [
      SEEDED_ORG_IDS,
    ]);
    await db.end();
  });

  test("keeps signed-out users on commerce onboarding with inline signup", async ({
    page,
  }) => {
    const email = uniqueEmail("commerce-inline");
    await page.goto("/commerce-onboarding?siteUrl=example.com");

    await expect(page).toHaveURL(
      (url) => url.pathname === "/commerce-onboarding",
    );
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Need help? Talk to us",
      }),
    ).toBeVisible();

    await signUpOnCurrentLoginPage(page, email);

    // After site setup the flow hands off to the org: it redirects off
    // /commerce-onboarding to the report route, where the blocking connections
    // modal (with the "View diagnostic" CTA) opens over the report.
    await page.waitForURL((url) => url.pathname !== "/commerce-onboarding", {
      timeout: 20_000,
    });
    await expect(
      page.getByRole("button", { name: "View diagnostic" }),
    ).toBeVisible({
      timeout: 20_000,
    });

    const userId = await findUserId(db, email);
    for (const orgId of await orgIdsForUser(db, userId)) {
      commerceDiscoveryOrgIds.add(orgId);
    }
  });

  test("sets up Commerce Discovery from siteUrl", async ({ page }) => {
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-discovery-setup"),
      name: `Commerce Discovery ${RUN_ID}`,
    });
    const orgId = await trackCommerceDiscoveryOrgForSlug(db, user.orgSlug);
    const connectionId = commerceDiscoveryConnectionId(orgId);
    const virtualMcpId = commerceDiscoveryVirtualMcpId(orgId);

    await page.goto("/commerce-onboarding?siteUrl=https://example.com/path");

    await expect(
      page.getByRole("button", { name: "View diagnostic" }),
    ).toBeVisible({
      timeout: 20_000,
    });

    await waitForConnection(db, connectionId);
    await waitForConnection(db, virtualMcpId);

    const concrete = await db.query<{
      connection_url: string | null;
      connection_type: string;
      title: string;
      connection_token: string | null;
    }>(
      `SELECT connection_url, connection_type, title, connection_token
       FROM connections
       WHERE id = $1`,
      [connectionId],
    );
    expect(concrete.rows[0]).toMatchObject({
      // The host is environment-specific (REPORTS_INTERNAL_API_URL);
      // assert only the invariant path suffix.
      connection_url: expect.stringMatching(/\/api\/v2\/mcp$/),
      connection_type: "HTTP",
      title: "Store Report",
    });
    // Setup must mint and persist a client token (stored encrypted at rest) —
    // a non-null token guards against the old stub silently creating a
    // tokenless connection.
    expect(concrete.rows[0]?.connection_token).toBeTruthy();

    const virtual = await db.query<{
      connection_url: string | null;
      connection_type: string;
      title: string;
      pinned: boolean;
    }>(
      `SELECT connection_url, connection_type, title, pinned
       FROM connections
       WHERE id = $1`,
      [virtualMcpId],
    );
    expect(virtual.rows[0]).toMatchObject({
      connection_url: `virtual://${virtualMcpId}`,
      connection_type: "VIRTUAL",
      title: "Report Agent",
      pinned: true,
    });
  });

  test("skips site URL input when Commerce Discovery is already set up", async ({
    page,
  }) => {
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-discovery-ready"),
      name: `Commerce Discovery Ready ${RUN_ID}`,
    });
    await trackCommerceDiscoveryOrgForSlug(db, user.orgSlug);

    await page.goto("/commerce-onboarding?siteUrl=example.com");
    await expect(
      page.getByRole("button", { name: "View diagnostic" }),
    ).toBeVisible({
      timeout: 20_000,
    });

    await page.goto("/commerce-onboarding");

    await expect(page.getByLabel("Site URL")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "View diagnostic" }),
    ).toBeVisible({
      timeout: 20_000,
    });
    // The old "Companion MCPs" placeholder was replaced by the companion
    // section, whose header is hidden when no companion requirements resolve
    // (the case in this e2e env). The ready view is already asserted via the
    // "View diagnostic" CTA above; here we only guard against leaking raw
    // connection titles into the onboarding view.
    await expect(page.getByText("Commerce Discovery MCP")).toHaveCount(0);
    await expect(page.getByText("Commerce Discovery agent")).toHaveCount(0);
  });

  test("keeps the meeting visual stable while ready setup data loads", async ({
    page,
  }) => {
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-visual-stable"),
      name: `Commerce Visual Stable ${RUN_ID}`,
    });
    await trackCommerceDiscoveryOrgForSlug(db, user.orgSlug);

    await page.route(
      "**/api/*/tools/COLLECTION_CONNECTIONS_GET",
      async (route) => {
        await sleep(3_000);
        await route.continue();
      },
    );

    await page.goto("/commerce-onboarding?siteUrl=example.com");

    const loading = page.getByText(
      "Connect your tools to see the full diagnostic",
    );
    const meetingHeading = page.getByRole("heading", {
      name: "Need help? Talk to us",
    });

    await expect(loading).toBeVisible();
    await expect(async () => {
      await expect(loading).toBeVisible();
      await expect(meetingHeading).toBeVisible();
    }, "the Suspense fallback keeps the meeting visual visible").toPass({
      timeout: 1_000,
    });
    await expect(
      page.getByRole("button", { name: "View diagnostic" }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("asks for a site URL when none is provided and rejects invalid URLs", async ({
    page,
  }) => {
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-site-url"),
      name: `Commerce Site URL ${RUN_ID}`,
    });
    await trackCommerceDiscoveryOrgForSlug(db, user.orgSlug);

    await page.goto("/commerce-onboarding");

    await expect(page.getByLabel("Site URL")).toBeVisible();
    await page.getByLabel("Site URL").fill("ftp://example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("Use an HTTP or HTTPS website URL."),
    ).toBeVisible();

    await page.getByLabel("Site URL").fill("example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("button", { name: "View diagnostic" }),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("opens the full Commerce Discovery report with app tab", async ({
    page,
  }) => {
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-report"),
      name: `Commerce Report ${RUN_ID}`,
    });
    const orgId = await trackCommerceDiscoveryOrgForSlug(db, user.orgSlug);
    const connectionId = commerceDiscoveryConnectionId(orgId);
    const virtualMcpId = commerceDiscoveryVirtualMcpId(orgId);

    await page.goto("/commerce-onboarding?siteUrl=example.com");

    // The connect step is a blocking modal over the org: it must NOT be
    // dismissable. Pressing Escape leaves it open; the only way forward is the
    // "View diagnostic" CTA.
    const reportCta = page.getByRole("button", {
      name: "View diagnostic",
    });
    await expect(reportCta).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(reportCta).toBeVisible();

    await reportCta.click();

    // Report app open in the main panel, chat side panel closed
    // (sidepanel=0 overrides the report agent's chatDefaultOpen).
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith(`/${user.orgSlug}/`) &&
        url.searchParams.get("virtualmcpid") === virtualMcpId &&
        url.searchParams.get("main") ===
          `app:${connectionId}:get_my_diagnostic` &&
        url.searchParams.get("sidepanel") === "0",
      { timeout: 20_000 },
    );

    const sidebarOpen = await page.evaluate(() =>
      window.localStorage.getItem("studio:sidebar-open"),
    );
    expect(sidebarOpen).toBe("false");
  });

  test("keeps ambiguous domain users in commerce onboarding", async ({
    page,
  }) => {
    const email = uniqueEmail("commerce-ambiguous", TEST_DOMAIN);
    await signUp(page, { email });
    const userId = await findUserId(db, email);

    await verifyUserAndClearMembership(db, userId);

    await page.goto("/commerce-onboarding");

    await expect(page.getByText(ORG_A_NAME)).toBeVisible();
    await expect(page.getByText(ORG_B_NAME)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/commerce-onboarding");
  });

  test("creates a full-domain org and claim for verified corporate zero-org users", async ({
    page,
  }) => {
    const domain = `commerce-e2e-${RUN_ID}-create.test`;
    const expectedSlug = domainToSlug(domain);
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-create", domain),
      name: `Commerce Create ${RUN_ID}`,
    });
    await verifyUserAndClearMembership(db, user.userId);

    await page.goto("/commerce-onboarding");

    await expect(page.getByLabel("Site URL")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/commerce-onboarding");

    const orgId = await orgIdForSlug(db, expectedSlug);
    const memberRow = await db.query<{ id: string }>(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [user.userId, orgId],
    );
    expect(memberRow.rows).toHaveLength(1);

    const claimRow = await db.query<{
      join_mode: string;
      verification_status: string;
      verification_method: string | null;
    }>(
      `SELECT join_mode, verification_status, verification_method
       FROM organization_domains
       WHERE organization_id = $1 AND domain = $2`,
      [orgId, domain],
    );
    expect(claimRow.rows[0]).toEqual({
      join_mode: "auto",
      verification_status: "verified",
      verification_method: "email",
    });
  });

  test("auto-joins a future verified corporate user to an unambiguous domain org", async ({
    page,
  }) => {
    const domain = `commerce-e2e-${RUN_ID}-join.test`;
    const org = {
      id: `e2e_commerce_join_${RUN_ID}`,
      name: `Commerce E2E Join ${RUN_ID}`,
      slug: `commerce-e2e-${RUN_ID}-join`,
      domain,
    };
    await seedDomainOrg(db, org);
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-join", domain),
      name: `Commerce Join ${RUN_ID}`,
    });
    await verifyUserAndClearMembership(db, user.userId);

    await page.goto("/commerce-onboarding");

    await expect(page.getByLabel("Site URL")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/commerce-onboarding");

    const memberRow = await db.query<{ id: string }>(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [user.userId, org.id],
    );
    expect(memberRow.rows).toHaveLength(1);
  });

  test("keeps mixed auto and request domain candidates ambiguous during commerce recovery", async ({
    page,
  }) => {
    const domain = `commerce-e2e-${RUN_ID}-mixed.test`;
    const autoOrg = {
      id: MIXED_AUTO_ORG_ID,
      name: `Commerce E2E Mixed Auto ${RUN_ID}`,
      slug: `commerce-e2e-${RUN_ID}-mixed-auto`,
      domain,
      joinMode: "auto" as const,
    };
    const requestOrg = {
      id: MIXED_REQUEST_ORG_ID,
      name: `Commerce E2E Mixed Request ${RUN_ID}`,
      slug: `commerce-e2e-${RUN_ID}-mixed-request`,
      domain,
      joinMode: "request" as const,
    };
    await seedDomainOrg(db, autoOrg);
    await seedDomainOrg(db, requestOrg);
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-mixed", domain),
      name: `Commerce Mixed ${RUN_ID}`,
    });
    await verifyUserAndClearMembership(db, user.userId);

    await page.goto("/commerce-onboarding");

    await expect(page.getByText(autoOrg.name)).toBeVisible();
    await expect(page.getByText(requestOrg.name)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/commerce-onboarding");

    const autoMemberRow = await db.query<{ id: string }>(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [user.userId, autoOrg.id],
    );
    expect(autoMemberRow.rows).toHaveLength(0);
  });

  test("does not auto-join archived domain orgs during commerce recovery", async ({
    page,
  }) => {
    const domain = `commerce-e2e-${RUN_ID}-archived.test`;
    const expectedSlug = domainToSlug(domain);
    const archivedOrg = {
      id: `e2e_commerce_archived_${RUN_ID}`,
      name: `Commerce E2E Archived ${RUN_ID}`,
      slug: `commerce-e2e-${RUN_ID}-archived`,
      domain,
      archived: true,
    };
    await seedDomainOrg(db, archivedOrg);
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-archived", domain),
      name: `Commerce Archived ${RUN_ID}`,
    });
    await verifyUserAndClearMembership(db, user.userId);

    await page.goto("/commerce-onboarding");

    await expect(page.getByLabel("Site URL")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/commerce-onboarding");

    const createdOrgId = await orgIdForSlug(db, expectedSlug);
    expect(createdOrgId).not.toBe(archivedOrg.id);

    const archivedMemberRow = await db.query<{ id: string }>(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [user.userId, archivedOrg.id],
    );
    expect(archivedMemberRow.rows).toHaveLength(0);

    const createdMemberRow = await db.query<{ id: string }>(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [user.userId, createdOrgId],
    );
    expect(createdMemberRow.rows).toHaveLength(1);
  });

  test("does not offer archived domain orgs during general onboarding", async ({
    page,
  }) => {
    const domain = `commerce-e2e-${RUN_ID}-onboarding-archived.test`;
    const archivedOrg = {
      id: ONBOARDING_ARCHIVED_ORG_ID,
      name: `Commerce E2E Onboarding Archived ${RUN_ID}`,
      slug: `commerce-e2e-${RUN_ID}-onboarding-archived`,
      domain,
      archived: true,
    };
    await seedDomainOrg(db, archivedOrg);
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("commerce-onboarding-archived", domain),
      name: `Commerce Onboarding Archived ${RUN_ID}`,
    });
    await verifyUserAndClearMembership(db, user.userId);

    await page.goto("/onboarding");

    await expect(page.getByText("Welcome to deco")).toBeVisible();
    await expect(page.getByText(archivedOrg.name)).toHaveCount(0);

    const archivedMemberRow = await db.query<{ id: string }>(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [user.userId, archivedOrg.id],
    );
    expect(archivedMemberRow.rows).toHaveLength(0);
  });

  test("keeps the general onboarding route isolated from commerce onboarding", async ({
    page,
  }) => {
    const user = await signUpViaApi(page.context().request, {
      email: uniqueEmail("general-route"),
      name: `General Route ${RUN_ID}`,
    });
    await verifyUserAndClearMembership(db, user.userId);

    await page.goto("/onboarding");

    await expect(page).toHaveURL((url) => url.pathname === "/onboarding");
    await expect(page.getByLabel("Site URL")).toHaveCount(0);
    await expect(page.getByText("Commerce Discovery")).toHaveCount(0);
  });
});
