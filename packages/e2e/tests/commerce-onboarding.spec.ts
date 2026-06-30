import { type Page } from "@playwright/test";
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

async function signUpOnCurrentLoginPage(page: Page, email: string) {
  const nameField = page.getByPlaceholder("Your name");
  const inSignupMode = await nameField
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!inSignupMode) {
    await page.getByRole("button", { name: "Sign up" }).click();
    await nameField.waitFor({ state: "visible" });
  }

  await nameField.fill(`Commerce ${Date.now()}`);
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("••••••••").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
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

  test("returns signed-out users to commerce onboarding after signup", async ({
    page,
  }) => {
    await page.goto("/commerce-onboarding");

    await page.waitForURL(
      (url) =>
        url.pathname === "/login" &&
        url.searchParams.get("next") === "/commerce-onboarding",
      { timeout: 15_000 },
    );

    await signUpOnCurrentLoginPage(page, uniqueEmail("commerce-return"));

    await page.waitForURL((url) => url.pathname === "/commerce-onboarding", {
      timeout: 15_000,
    });
    await expect(page.getByText("Commerce diagnostics")).toBeVisible();
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

    await expect(page.getByText("Commerce diagnostics")).toBeVisible();
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

    await expect(page.getByText("Commerce diagnostics")).toBeVisible();
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

    await expect(page.getByText("Commerce diagnostics")).toBeVisible();
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
    await expect(page.getByText("Commerce diagnostics")).toHaveCount(0);
  });
});
