/**
 * E2E: capability gating of the Connections, Agents and Monitor surfaces.
 *
 * Drives the real browser as a built-in "user" member:
 *   - Monitor is capability-gated (monitoring:view) → no-access panel;
 *   - Connections stay viewable (basic-usage) but the create affordance is
 *     hidden (connections:manage);
 *   - Agents are manageable — the built-in user role is granted agents:manage
 *     (USER_ROLE_CAPABILITY_IDS), so the create affordance is shown.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

const ORIGIN = `http://localhost:${process.env.PORT ?? "3000"}`;

/**
 * Sign the page in as a fresh user, join `orgId` as a built-in "user", and make
 * it the active org. Returns nothing — the page is left authenticated.
 */
async function joinAsUser(
  page: Page,
  ownerCtx: APIRequestContext,
  orgId: string,
): Promise<void> {
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

  const accept = await page
    .context()
    .request.post("/api/auth/organization/accept-invitation", {
      data: { invitationId },
      headers: { Origin: ORIGIN },
    });
  expect(
    accept.ok(),
    `accept-invitation failed: ${await accept.text().catch(() => "")}`,
  ).toBe(true);

  await page.context().request.post("/api/auth/organization/set-active", {
    data: { organizationId: orgId },
    headers: { Origin: ORIGIN },
  });
}

test.describe("connections / agents / monitor gating", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("a plain member can't manage connections or view monitoring, but can manage agents", async ({
    page,
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgRow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [owner.orgSlug],
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new Error("org not found after signup");

    await joinAsUser(page, ownerCtx, orgId);

    // Monitor is gated by monitoring:view → no-access panel.
    await page.goto(`/${owner.orgSlug}/settings/monitor`);
    await expect(page.getByText("No access to monitoring")).toBeVisible({
      timeout: 15_000,
    });

    // Connections page loads (viewing is basic-usage) but the create CTA is
    // hidden without connections:manage.
    await page.goto(`/${owner.orgSlug}/settings/connections`);
    await expect(page.getByPlaceholder("Search for a connection")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Custom Connection" }),
    ).toHaveCount(0);

    // Agents page loads and the create CTA IS shown — the built-in user role
    // is granted agents:manage (USER_ROLE_CAPABILITY_IDS).
    await page.goto(`/${owner.orgSlug}/settings/agents`);
    await expect(page.getByPlaceholder("Search for an agent...")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Create Agent" }),
    ).toBeVisible();

    await ownerCtx.dispose();
  });

  test("the owner sees the management affordances", async ({ page }) => {
    const owner = await signUpViaApi(page.context().request);

    await page.goto(`/${owner.orgSlug}/settings/connections`);
    await expect(
      page.getByRole("button", { name: "Custom Connection" }),
    ).toBeVisible({ timeout: 15_000 });

    await page.goto(`/${owner.orgSlug}/settings/monitor`);
    await expect(page.getByText("No access to monitoring")).toHaveCount(0);
  });
});
