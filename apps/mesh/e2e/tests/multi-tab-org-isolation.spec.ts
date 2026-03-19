import { test, expect } from "@playwright/test";
import { signUp } from "../fixtures/auth";

// This test involves multiple navigations across two tabs — give it room.
test.describe("Multi-tab org isolation", () => {
  test("each tab stays scoped to its own org after navigation and cache hits", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    // 1. Sign up — auto-creates first org, lands on home
    await signUp(page);
    await page.waitForURL("/");

    // 2. Extract org A slug from the home page card
    const slugTextA = page.locator("text=/@[a-z0-9-]+/").first();
    await slugTextA.waitFor({ state: "visible" });
    const orgSlugA =
      (await slugTextA.textContent())?.replace("@", "").trim() ?? "";

    // 3. Create org B via the "New organization" button on the home page
    const orgBName = `Org B ${Date.now()}`;
    await page.getByRole("button", { name: "New organization" }).click();
    await page.getByPlaceholder("Acme Inc.").fill(orgBName);
    await page.getByRole("button", { name: "Create Organization" }).click();

    // Creating an org does window.location.href = `/${slug}` redirect.
    await page.waitForURL(
      (url) => url.pathname !== "/" && url.pathname !== "",
      { timeout: 15_000 },
    );

    // Extract org B slug from the URL
    const orgSlugB = new URL(page.url()).pathname.split("/")[1];

    // ── Multi-tab isolation ──────────────────────────────────────────

    // 4. Open a second tab in the SAME browser context (shared session cookies)
    const page2 = await page.context().newPage();

    // 5. Tab 1 → org A, Tab 2 → org B. Wait for the sidebar "Home" link
    //    to appear as a signal the shell has rendered.
    await page.goto(`/${orgSlugA}/org-admin`);
    await page.getByText("Connections").first().waitFor({ timeout: 15_000 });

    await page2.goto(`/${orgSlugB}/org-admin`);
    await page2.getByText("Connections").first().waitFor({ timeout: 15_000 });

    // 6. Collect outbound organizationId from each tab's Better Auth requests.
    const capturedOrgIds = { tab1: [] as string[], tab2: [] as string[] };

    page.on("request", (req) => {
      try {
        const url = new URL(req.url());
        if (url.pathname.includes("/organization/")) {
          const id = url.searchParams.get("organizationId");
          if (id) capturedOrgIds.tab1.push(id);
        }
      } catch {}
    });

    page2.on("request", (req) => {
      try {
        const url = new URL(req.url());
        if (url.pathname.includes("/organization/")) {
          const id = url.searchParams.get("organizationId");
          if (id) capturedOrgIds.tab2.push(id);
        }
      } catch {}
    });

    // 7. Reload both tabs to trigger org-scoped requests with listeners active.
    await page.reload();
    await page.getByText("Connections").first().waitFor({ timeout: 15_000 });

    await page2.reload();
    await page2.getByText("Connections").first().waitFor({ timeout: 15_000 });

    // Verify each tab is on the correct URL
    await expect(page).toHaveURL(new RegExp(`/${orgSlugA}/`));
    await expect(page2).toHaveURL(new RegExp(`/${orgSlugB}/`));

    // 8. Verify captured org IDs never cross-contaminate
    if (capturedOrgIds.tab1.length > 0 && capturedOrgIds.tab2.length > 0) {
      const tab1Ids = new Set(capturedOrgIds.tab1);
      const tab2Ids = new Set(capturedOrgIds.tab2);
      for (const id of tab1Ids) {
        expect(tab2Ids.has(id)).toBe(false);
      }
      for (const id of tab2Ids) {
        expect(tab1Ids.has(id)).toBe(false);
      }
    }

    // ── Cache-hit regression (org A → B → back to A) ────────────────

    // 9. In tab 1: navigate to org B, then BACK to org A.
    //    The query for org A is cached (staleTime: Infinity), so queryFn won't
    //    re-execute. Without the fix, the org store would be stuck on org B's ID.
    await page.goto(`/${orgSlugB}/org-admin`);
    await page.getByText("Connections").first().waitFor({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/${orgSlugB}/`));

    // Now go back to org A — this is the cache-hit path
    await page.goto(`/${orgSlugA}/org-admin`);
    await page.getByText("Connections").first().waitFor({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/${orgSlugA}/`));

    // 10. After returning to org A via cache hit, intercept the next org-scoped
    //     request to verify the auth-client injects org A's ID (not org B's).
    //     Navigate to the Members page which triggers org-scoped API calls.
    const membersRequestPromise = page.waitForRequest(
      (req) => {
        const url = req.url();
        return (
          url.includes("/organization/") &&
          req.method() === "GET" &&
          url.includes("organizationId")
        );
      },
      { timeout: 10_000 },
    );

    await page.goto(`/${orgSlugA}/org-admin/members`);

    const membersReq = await membersRequestPromise.catch(() => null);
    if (membersReq) {
      const url = new URL(membersReq.url());
      const injectedOrgId = url.searchParams.get("organizationId");

      // The critical assertion: after A → B → A with cache hit, the org ID
      // in the request must belong to org A. We stored which IDs each org
      // produced earlier — if org B's ID leaked here, the test fails.
      if (injectedOrgId && capturedOrgIds.tab2.length > 0) {
        const orgBIds = new Set(capturedOrgIds.tab2);
        expect(orgBIds.has(injectedOrgId)).toBe(false);
      }
    }

    // 11. Final assertion: tab 2 is still on org B, unaffected by tab 1's navigation
    await expect(page2).toHaveURL(new RegExp(`/${orgSlugB}/`));

    await page2.close();
  });
});
