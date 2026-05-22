import { expect, test } from "@playwright/test";
import { signUp } from "../fixtures/auth";

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
    // Wait for the post-signup redirect off /login so we know auth is established.
    await page.waitForURL(
      (url) => {
        const slug = url.pathname.split("/")[1];
        return !!slug && slug !== "login" && slug !== "api";
      },
      { timeout: 15_000 },
    );

    // Pick a slug that almost certainly doesn't exist.
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
    await page.waitForURL(
      (url) => {
        const slug = url.pathname.split("/")[1];
        return !!slug && slug !== "login" && slug !== "api";
      },
      { timeout: 15_000 },
    );
    const orgASlug = new URL(page.url()).pathname.split("/")[1];

    // Sign out by clearing the session cookie so we can sign up as a second user.
    await context.clearCookies();

    // User B — fresh signup, no membership in org A.
    await signUp(page);
    await page.waitForURL(
      (url) => {
        const slug = url.pathname.split("/")[1];
        return !!slug && slug !== "login" && slug !== "api";
      },
      { timeout: 15_000 },
    );

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
    await page.waitForURL(
      (url) => {
        const slug = url.pathname.split("/")[1];
        return !!slug && slug !== "login" && slug !== "api";
      },
      { timeout: 15_000 },
    );
    const orgASlug = new URL(page.url()).pathname.split("/")[1];

    // Pre-mint the address we'll invite + sign up B with, so they match.
    const bEmail = `invitee-${Date.now()}@playwright.local`;

    // Invite B via the members settings page.
    await page.goto(`/${orgASlug}/settings/members`);
    await page.getByRole("button", { name: "Invite Member" }).click();
    await expect(
      page.getByRole("heading", { name: "Invite members" }),
    ).toBeVisible();
    await page.getByPlaceholder(/Enter email addresses/i).fill(bEmail);
    // Default role ("user") is already selected; submit.
    await page.getByRole("button", { name: /^Invite \d+ Member/ }).click();
    // Wait for the dialog to close (success path).
    await expect(
      page.getByRole("heading", { name: "Invite members" }),
    ).not.toBeVisible({ timeout: 10_000 });

    // Swap principals: clear cookies and sign up B with the invited email.
    await context.clearCookies();
    await signUp(page, { email: bEmail });
    await page.waitForURL(
      (url) => {
        const slug = url.pathname.split("/")[1];
        return !!slug && slug !== "login" && slug !== "api";
      },
      { timeout: 15_000 },
    );

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
