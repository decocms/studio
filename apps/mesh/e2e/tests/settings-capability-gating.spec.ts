/**
 * E2E: capability-based gating of the settings UI.
 *
 * Drives the real browser as a restricted member (built-in "user" role, which
 * resolves to no gated capabilities) and asserts the gating wired up in the
 * settings layout + route guards + capability-aware index redirect:
 *
 *   - direct-navigating to a management settings route shows the no-access
 *     panel instead of the page;
 *   - the /settings index lands a no-management member on Profile (the always-
 *     accessible fallback), and an owner on General;
 *
 * The capability resolution itself is unit + e2e tested at the endpoint
 * (my-capabilities.spec.ts); this spec covers the UI consuming it.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

test.describe("settings capability gating", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("a plain member is gated out of management settings", async ({
    page,
    playwright,
  }) => {
    // Owner of org A (separate API context so it doesn't share the page's
    // cookies).
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgRow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [owner.orgSlug],
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new Error("org A not found after signup");

    // The PAGE becomes a second user (gets their own org), then joins org A as
    // a built-in "user" — no management capabilities there.
    const member = await signUpViaApi(page.context().request);

    const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
      data: { organizationId: orgId, email: member.email, role: "user" },
    });
    expect(invite.ok()).toBe(true);
    const inviteJson = (await invite.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const invitationId = inviteJson.id ?? inviteJson.invitation?.id;
    expect(invitationId).toBeTruthy();

    const accept = await page
      .context()
      .request.post("/api/auth/organization/accept-invitation", {
        data: { invitationId },
      });
    expect(
      accept.ok(),
      `accept-invitation failed: ${await accept.text().catch(() => "")}`,
    ).toBe(true);

    // Make org A the member's active org so the shell loads it deterministically
    // (signup left their own org active).
    await page.context().request.post("/api/auth/organization/set-active", {
      data: { organizationId: orgId },
    });

    // Direct-navigating to a management route renders the no-access panel
    // (the route guard denies) instead of the General settings page.
    await page.goto(`/${owner.orgSlug}/settings/general`);
    await expect(page.getByText("No access to general settings")).toBeVisible({
      timeout: 15_000,
    });

    // The settings index redirects a no-management member to Profile — the
    // always-accessible fallback — rather than landing them on a denied tab.
    await page.goto(`/${owner.orgSlug}/settings`);
    await page.waitForURL((url) => url.pathname.endsWith("/settings/profile"), {
      timeout: 15_000,
    });

    // The Members management nav item is filtered out for this member; the
    // count check (vs. a single-element assertion) avoids strict-mode flakes.
    await expect(
      page.getByRole("link", { name: "Members", exact: true }),
    ).toHaveCount(0);
  });

  test("the owner reaches management settings normally", async ({ page }) => {
    const owner = await signUpViaApi(page.context().request);

    // The index sends a privileged user to General (proves org:manage is
    // granted) — not the Profile fallback — and the page renders without the
    // no-access panel.
    await page.goto(`/${owner.orgSlug}/settings`);
    await page.waitForURL((url) => url.pathname.endsWith("/settings/general"), {
      timeout: 15_000,
    });
    await expect(page.getByText("No access to general settings")).toHaveCount(
      0,
    );
  });
});
