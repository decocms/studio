import { type Page } from "@playwright/test";
import { type Client } from "pg";
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
const PASSWORD = "Playwright123!";

function uniqueEmail(prefix: string, domain = "playwright.local") {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@${domain}`;
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

    await db.query(`DELETE FROM organization_domains WHERE domain = $1`, [
      TEST_DOMAIN,
    ]);
    await db.query(`DELETE FROM "member" WHERE "organizationId" IN ($1, $2)`, [
      ORG_A_ID,
      ORG_B_ID,
    ]);
    await db.query(`DELETE FROM "organization" WHERE id IN ($1, $2)`, [
      ORG_A_ID,
      ORG_B_ID,
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

    await db.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [
      userId,
    ]);
    await db.query(`DELETE FROM "member" WHERE "userId" = $1`, [userId]);

    await page.goto("/commerce-onboarding");

    await expect(page).toHaveURL(/\/commerce-onboarding/);
    expect(new URL(page.url()).pathname).not.toBe("/onboarding");
    await expect(page.getByText(ORG_A_NAME)).toBeVisible();
    await expect(page.getByText(ORG_B_NAME)).toBeVisible();
  });
});
