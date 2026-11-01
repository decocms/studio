/**
 * Cold entry ("/") restores the org cached in localStorage. When that org no
 * longer exists for the user, "/" must land on one of their real orgs instead
 * of stopping at "Organization not found". A link straight to a missing org
 * still shows that screen.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { expect, test } from "../fixtures/test";

const GHOST = `ghost-org-${Date.now()}`;

const CACHES = {
  "last location": { "studio:last-location": JSON.stringify({ org: GHOST }) },
  "last org slug": { "studio:last-org-slug": GHOST },
  both: {
    "studio:last-location": JSON.stringify({ org: GHOST }),
    "studio:last-org-slug": GHOST,
  },
};

test.describe("stale cached organization", () => {
  for (const [label, cache] of Object.entries(CACHES)) {
    test(`"/" recovers from a stale ${label}`, async ({ page }) => {
      // Seed signed out: a signed-in /login redirects and records the real org.
      await page.goto("/login");
      await page.evaluate((entries) => {
        for (const [key, value] of Object.entries(entries)) {
          localStorage.setItem(key, value);
        }
      }, cache);
      const user = await signUpViaApi(page.context().request);

      await page.goto("/");

      await expect(page).toHaveURL(new RegExp(`/${user.orgSlug}(/|$)`));
      await expect(page.getByText("Organization not found")).toHaveCount(0);
    });
  }

  test("a link to a missing org still shows not found", async ({ page }) => {
    await signUpViaApi(page.context().request);

    await page.goto(`/${GHOST}`);

    await expect(page.getByText("Organization not found")).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("studio:last-location")),
    ).toBeNull();
  });
});
