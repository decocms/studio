import { signUp } from "../fixtures/auth";
import { SettingsMembersPage } from "../pages/settings-members";
import {
  expect,
  extractOrgSlugFromUrl,
  test,
  waitForPostSignupRedirect,
} from "../fixtures/test";

/**
 * Regression for the "infinite loading" shell when visiting /:org you don't
 * belong to. Covers the three concrete branches the gate must show:
 *   - org slug doesn't exist  → "Organization not found"
 *   - pending invitation       → "You've been invited" + accept flow
 *   - (auto-domain-join needs domain seeding that's awkward via the UI,
 *      so the integration test in apps/mesh/src/api/routes/auth.test.ts
 *      covers it end-to-end against the real DB.)
 */
test.describe("Org access gate", () => {
  test("shows the not-found screen when the org slug doesn't exist", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);

    const fakeSlug = `definitely-not-a-real-org-${Date.now()}`;
    await page.goto(`/${fakeSlug}/`);

    await expect(
      page.getByRole("heading", { name: "Organization not found" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: "Go to home" }),
    ).toBeVisible();
    await page.screenshot({
      path: "screenshots/not-found.png",
      fullPage: true,
    });
  });

  test("shows the no-access screen for an existing org the user isn't in", async ({
    page,
    context,
  }) => {
    // User A — creates their own org (auto-created at signup).
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgASlug = extractOrgSlugFromUrl(page);

    // Sign out by clearing the session cookie so we can sign up as a second user.
    await context.clearCookies();

    // User B — fresh signup, no membership in org A.
    await signUp(page);
    await waitForPostSignupRedirect(page);

    // Navigate to org A — user B has no invite, no auto-join, so should see
    // the no-access screen rather than hang on the splash.
    await page.goto(`/${orgASlug}/`);
    await expect(page.getByRole("heading", { name: "No access" })).toBeVisible({
      timeout: 10_000,
    });
    await page.screenshot({
      path: "screenshots/no-access.png",
      fullPage: true,
    });
  });

  test("shows the pending-invite screen and accepting it lands in the org", async ({
    page,
    context,
  }) => {
    // User A — creates org A.
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgASlug = extractOrgSlugFromUrl(page);

    // Pre-mint the address we'll invite + sign up B with, so they match.
    const bEmail = `invitee-${Date.now()}@playwright.local`;

    const members = new SettingsMembersPage(page);
    await members.goto(orgASlug);
    await members.openInviteDialog();
    await members.inviteByEmail(bEmail);

    // Swap principals: clear cookies and sign up B with the invited email.
    await context.clearCookies();
    await signUp(page, { email: bEmail });
    await waitForPostSignupRedirect(page);

    // B navigates to org A — should see the pending-invite screen, not hang.
    await page.goto(`/${orgASlug}/`);
    await expect(page.getByText(/You.*been invited to/i)).toBeVisible({
      timeout: 10_000,
    });
    await page.screenshot({
      path: "screenshots/pending-invite.png",
      fullPage: true,
    });

    // Accepting redirects B into org A.
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await page.waitForURL(new RegExp(`/${orgASlug}(/|$)`), {
      timeout: 15_000,
    });
  });
});
