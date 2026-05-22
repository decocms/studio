/**
 * Multi-org auto-join onboarding flow.
 *
 * Validates that when two organizations claim the same corporate email
 * domain with auto-join enabled, a new corporate user landing on
 * /onboarding sees a picker listing both orgs and can join the one they
 * choose. This is the user-visible payoff of migration
 * 091-organization-domains-allow-multi (which dropped the UNIQUE
 * constraint on `organization_domains.domain`).
 *
 * The picker UI / domain-lookup flow can't be set up purely via UI —
 * claiming a domain in an org requires `emailVerified: true`, which
 * needs an OTP/magic-link verification flow we can't easily drive
 * headlessly. So this spec connects to the dev server's embedded
 * Postgres (see e2e/fixtures/db.ts) and seeds the two pre-claiming orgs
 * directly. The user under test still signs up through the real UI,
 * and the picker + join action are exercised through the real DOM.
 */

import { type Client } from "pg";
import { expect, test } from "@playwright/test";
import { connectDevDb } from "../fixtures/db";
import { signUp } from "../fixtures/auth";

/** Unique per-spec-run domain. Avoids collisions across re-runs and
 *  across parallel test files (Playwright config pins workers: 1, but
 *  the suffix keeps cleanup simple even if that changes). */
const TEST_DOMAIN = `acme-e2e-${Date.now()}.test`;
const ORG_A_SLUG = `e2e-acme-a-${Date.now()}`;
const ORG_B_SLUG = `e2e-acme-b-${Date.now()}`;
const ORG_A_ID = `e2e_org_a_${Date.now()}`;
const ORG_B_ID = `e2e_org_b_${Date.now()}`;

test.describe("Onboarding: multi-org auto-join picker", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();

    const now = new Date().toISOString();

    // Two orgs that both claim TEST_DOMAIN with auto-join enabled. No
    // member rows — these are "siblings" in the picker, and the test
    // user is intentionally not a member of either.
    await db.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, $4), ($5, $6, $7, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        ORG_A_ID,
        "Acme E2E A",
        ORG_A_SLUG,
        now,
        ORG_B_ID,
        "Acme E2E B",
        ORG_B_SLUG,
      ],
    );

    await db.query(
      `INSERT INTO organization_domains
         (organization_id, domain, auto_join_enabled, created_at, updated_at)
       VALUES ($1, $3, true, $4, $4), ($2, $3, true, $4, $4)
       ON CONFLICT (organization_id) DO UPDATE
         SET domain = EXCLUDED.domain,
             auto_join_enabled = EXCLUDED.auto_join_enabled,
             updated_at = EXCLUDED.updated_at`,
      [ORG_A_ID, ORG_B_ID, TEST_DOMAIN, now],
    );
  });

  test.afterAll(async () => {
    if (!db) return;
    // organization_domains rows cascade with the organization, but be
    // explicit so a partial failure mid-seed doesn't leave orphans.
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

  /**
   * Sign up a fresh user via the real UI with an email on TEST_DOMAIN,
   * then SQL-tweak them into the state /onboarding requires:
   *   - emailVerified=true (so /domain-lookup will resolve their domain)
   *   - no org memberships (so the home route redirects to /onboarding
   *     instead of into their auto-created org)
   *
   * Returns the user's id + email so the test can assert membership
   * end-state.
   */
  async function signUpCorporateUserOnTestDomain(
    page: import("@playwright/test").Page,
  ): Promise<{ userId: string; email: string }> {
    const suffix = Date.now() + Math.floor(Math.random() * 100000);
    const email = `corp-${suffix}@${TEST_DOMAIN}`;
    await signUp(page, { email });

    // signUp waits for redirect off /login; under the email/password
    // path the user has emailVerified=false and the signup hook
    // auto-creates an org. Both need undoing for /onboarding to work.
    const userRow = await db.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1`,
      [email],
    );
    const userId = userRow.rows[0]?.id;
    if (!userId) {
      throw new Error(`Test user ${email} not found in DB after signup`);
    }

    await db.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [
      userId,
    ]);

    // Tear down the auto-created org so /onboarding redirects fire.
    // Cascade isn't reliable across every FK target, so delete in order:
    // members → org. organization_domains is unrelated (auto-org doesn't
    // claim any domain) and stays untouched.
    const memberOrgs = await db.query<{ organizationId: string }>(
      `SELECT "organizationId" FROM "member" WHERE "userId" = $1`,
      [userId],
    );
    for (const { organizationId } of memberOrgs.rows) {
      await db.query(`DELETE FROM "member" WHERE "organizationId" = $1`, [
        organizationId,
      ]);
      await db.query(`DELETE FROM "organization" WHERE id = $1`, [
        organizationId,
      ]);
    }

    return { userId, email };
  }

  test("renders a picker with both orgs and joins the one the user picks", async ({
    page,
  }) => {
    const { userId } = await signUpCorporateUserOnTestDomain(page);

    // After undoing the auto-created org, hitting "/" runs the home
    // route's beforeLoad → no active orgs → redirects to /onboarding.
    // Going there directly skips an intermediate hop.
    await page.goto("/onboarding");

    // The picker renders one row per matching org with a per-row Join
    // button. The shared cluster headline differs from the single-org
    // copy ("You have access to an organization") — this assertion
    // protects the multi-org branch specifically.
    await expect(
      page.getByRole("heading", {
        name: "You have access to multiple organizations",
      }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Acme E2E A")).toBeVisible();
    await expect(page.getByText("Acme E2E B")).toBeVisible();

    // Two Join buttons — one per org row.
    const joinButtons = page.getByRole("button", { name: /^Join$/ });
    await expect(joinButtons).toHaveCount(2);

    // Each org row is a .card-shadow container with the org name and
    // its own Join button — filter the cards by visible text and click
    // the Join inside the right one.
    const orgACard = page
      .locator(".card-shadow")
      .filter({ hasText: "Acme E2E A" });
    await orgACard.getByRole("button", { name: /^Join$/ }).click();

    // Successful join → redirect to /<slug>.
    await page.waitForURL(new RegExp(`/${ORG_A_SLUG}(/|$)`), {
      timeout: 15_000,
    });

    // Membership is now persisted in the DB. Assert directly — the URL
    // alone could be fooled by a client-side redirect.
    const memberCheck = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "member"
       WHERE "userId" = $1 AND "organizationId" = $2`,
      [userId, ORG_A_ID],
    );
    expect(memberCheck.rows[0]!.count).toBe("1");

    // And the user is NOT in the other org — joining one must not
    // bleed into the other.
    const otherCheck = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "member"
       WHERE "userId" = $1 AND "organizationId" = $2`,
      [userId, ORG_B_ID],
    );
    expect(otherCheck.rows[0]!.count).toBe("0");

    await page.screenshot({
      path: "screenshots/auto-domain-join-multi-org.png",
      fullPage: true,
    });
  });
});
