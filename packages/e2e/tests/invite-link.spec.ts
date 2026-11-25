import type { Page } from "@playwright/test";
import { signUp } from "../fixtures/auth";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { SettingsMembersPage } from "../pages/settings-members";
import {
  expect,
  extractOrgSlugFromUrl,
  test,
  waitForPostSignupRedirect,
} from "../fixtures/test";

/** Invite links are behind a default-off org flag. */
async function setInviteLinksFlag(page: Page, orgSlug: string, on: boolean) {
  const { id } = await callSelfMcpTool<{ id: string }>(
    page.request,
    orgSlug,
    "ORGANIZATION_GET",
    {},
  );
  await callSelfMcpTool(page.request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: id,
    flags: { invite_links_enabled: on },
  });
  // Org settings persist across reloads (and are rewritten on pagehide), so
  // drop them before each boot to read the flag as a fresh browser would.
  await page.addInitScript(() => localStorage.removeItem("studio:rq-cache"));
}

/** Reads the generated link out of the copy row; headless clipboard is not reliable. */
async function createdInvitePath(page: Page): Promise<string> {
  const code = page.locator("code", { hasText: "/invite/" });
  await expect(code).toBeVisible({ timeout: 10_000 });
  return new URL((await code.textContent()) ?? "").pathname;
}

/**
 * A shareable invite link takes someone outside the org from the link,
 * through sign-up, into the org, and onto the page it was shared from.
 */
test.describe("Shareable invite link", () => {
  test("a new user joins through the Share button and lands on the shared page", async ({
    page,
    context,
  }, testInfo) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    await setInviteLinksFlag(page, orgSlug, true);

    // Share a page other than the org home, so landing there proves the redirect.
    const sharedPath = `/${orgSlug}/library`;
    await page.goto(sharedPath);
    const share = page.getByRole("button", { name: "Share" });
    await expect(share).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe(sharedPath);
    await share.click();
    await page
      .getByRole("button", { name: "Create invite link (24h)" })
      .click();
    const invitePath = await createdInvitePath(page);
    await page.screenshot({ path: testInfo.outputPath("share-popover.png") });

    await context.clearCookies();
    await page.goto(invitePath);
    await expect(page.getByText(/You.*been invited to/i)).toBeVisible({
      timeout: 10_000,
    });
    await page.screenshot({
      path: testInfo.outputPath("invite-signed-out.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Sign in to accept" }).click();
    await page.waitForURL(/\/login\?/);
    await signUp(page, { fromCurrentPage: true });

    await page.waitForURL((url) => url.pathname === invitePath, {
      timeout: 15_000,
    });
    const join = page.getByRole("button", { name: /^Join / });
    await expect(join).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: testInfo.outputPath("invite-signed-in.png"),
      fullPage: true,
    });
    await join.click();

    await page.waitForURL((url) => url.pathname === sharedPath, {
      timeout: 15_000,
    });
    expect(extractOrgSlugFromUrl(page)).toBe(orgSlug);
    await expect(page.getByRole("heading", { name: "No access" })).toHaveCount(
      0,
    );
  });

  test("a revoked link shows the unavailable screen", async ({
    page,
    context,
  }, testInfo) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    await setInviteLinksFlag(page, orgSlug, true);

    const members = new SettingsMembersPage(page);
    await members.goto(orgSlug);
    await members.openInviteDialog();
    await page
      .getByRole("button", { name: "Create invite link (24h)" })
      .click();
    const invitePath = await createdInvitePath(page);
    await page.screenshot({ path: testInfo.outputPath("invite-dialog.png") });
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Invite link revoked")).toBeVisible();

    await context.clearCookies();
    await signUp(page);
    await waitForPostSignupRedirect(page);
    await page.goto(invitePath);
    await expect(
      page.getByRole("heading", { name: "Invite link unavailable" }),
    ).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: testInfo.outputPath("invite-unavailable.png"),
      fullPage: true,
    });

    const accept = await page.request.post(
      `/api/auth/custom${invitePath.replace("/invite/", "/invite-link/")}/accept`,
    );
    expect(accept.status()).toBe(410);
  });

  test("with the flag off, the UI hides the invite and links stop working", async ({
    page,
    context,
  }, testInfo) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);

    // The org owner turns it on from Settings > General.
    await page.goto(`/${orgSlug}/settings/general`);
    const toggle = page.getByRole("switch", { name: "Invite links" });
    await expect(toggle).not.toBeChecked({ timeout: 30_000 });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("settings-toggle.png") });

    const members = new SettingsMembersPage(page);
    await members.goto(orgSlug);
    await members.openInviteDialog();
    await page
      .getByRole("button", { name: "Create invite link (24h)" })
      .click();
    const invitePath = await createdInvitePath(page);

    await setInviteLinksFlag(page, orgSlug, false);
    await page.reload();
    await members.openInviteDialog();
    await expect(page.getByText("Or share an invite link")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.goto(`/${orgSlug}/library`);
    await expect(page.getByRole("button", { name: "New folder" })).toBeVisible({
      timeout: 15_000,
    });
    // Share still offers a short link to the page; only the invite is gone.
    await page.getByRole("button", { name: "Share" }).click();
    await expect(page.getByText("Link to this page")).toBeVisible();
    await expect(
      page.getByText(/^http.*\/s\/(.+-)?[0-9A-Za-z]{10}$/),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Invite to this page")).toHaveCount(0);
    await page.keyboard.press("Escape");

    const create = await page.request.post(`/api/${orgSlug}/mcp/self`, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ORGANIZATION_INVITE_LINK_CREATE", arguments: {} },
      },
    });
    expect(await create.text()).toMatch(/not enabled/);

    await context.clearCookies();
    await page.goto(invitePath);
    await expect(
      page.getByRole("heading", { name: "Invite link unavailable" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("only members managers can create links, and never for owner", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    await setInviteLinksFlag(page, orgSlug, true);

    const callTool = (name: string, args: Record<string, unknown>) =>
      page.request.post(`/api/${orgSlug}/mcp/self`, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
      });

    const owner = await callTool("ORGANIZATION_INVITE_LINK_CREATE", {
      role: "owner",
    });
    expect(await owner.text()).toMatch(/Insufficient privileges/);

    const offsite = await callTool("ORGANIZATION_INVITE_LINK_CREATE", {
      redirectPath: "//evil.example/x",
    });
    expect(await offsite.text()).toMatch(/inside this organization/);

    await context.clearCookies();
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const outsider = await callTool("ORGANIZATION_INVITE_LINK_CREATE", {});
    expect(await outsider.text()).not.toMatch(/\/invite\//);
  });
});
