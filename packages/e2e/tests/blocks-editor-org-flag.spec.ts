import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

interface OrgSettings {
  flags: Record<string, boolean | undefined> | null;
}

const SWITCH_NAME = "New blocks editor";

test("a legacy browser opt-in no longer picks the blocks editor", async ({
  authedPage: { page, orgSlug },
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "studio:user:preferences",
      JSON.stringify({ theme: "dark", compactPageLayout: true }),
    );
  });
  await page.goto(`/${orgSlug}/settings/profile`);
  await expect(page.getByTestId("page-header")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("switch", { name: SWITCH_NAME, exact: true }),
  ).toHaveCount(0);

  await page.goto(`/${orgSlug}/settings/general`);
  await expect(
    page.getByRole("switch", { name: SWITCH_NAME, exact: true }),
  ).not.toBeChecked({ timeout: 60_000 });
});

test("the blocks editor switch is shared by the whole org", async ({
  authedPage: { page, orgSlug },
}) => {
  const readFlag = async () =>
    (
      await callSelfMcpTool<OrgSettings>(
        page.context().request,
        orgSlug,
        "ORGANIZATION_SETTINGS_GET",
        {},
      )
    ).flags?.new_blocks_editor;

  await page.goto(`/${orgSlug}/settings/general`);
  const toggle = page.getByRole("switch", { name: SWITCH_NAME, exact: true });
  await expect(toggle).not.toBeChecked({ timeout: 60_000 });
  // It picks the editor of v7 sites only; v8 sites always get the new one
  // (content-protocol-deco-serve.spec.ts asserts that with the flag off).
  await expect(page.getByText(/v8 sites always use it/)).toBeVisible();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(readFlag).toBe(true);

  // Another browser of the same org sees the org's choice, not its own.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(toggle).toBeChecked({ timeout: 60_000 });
  await expect(page.getByTestId("page-header")).toBeVisible();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(readFlag).toBe(false);
});

test("a regular member can switch the editor but not other org settings", async ({
  playwright,
}) => {
  const ownerCtx = await newApiContext(playwright);
  const owner = await signUpViaApi(ownerCtx);
  const orgId = await findOrgId(ownerCtx, owner.orgSlug);

  const memberCtx = await newApiContext(playwright);
  const member = await signUpViaApi(memberCtx);
  const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
    data: { organizationId: orgId, email: member.email, role: "user" },
  });
  expect(invite.ok()).toBe(true);
  const inviteJson = (await invite.json()) as {
    id?: string;
    invitation?: { id?: string };
  };
  const accept = await memberCtx.post(
    "/api/auth/organization/accept-invitation",
    { data: { invitationId: inviteJson.id ?? inviteJson.invitation?.id } },
  );
  expect(accept.ok()).toBe(true);

  const set = await memberCtx.post(
    `/api/${owner.orgSlug}/tools/ORGANIZATION_BLOCKS_EDITOR_SET`,
    { data: { enabled: true } },
  );
  expect(set.ok(), await set.text()).toBe(true);
  expect(await set.json()).toEqual({ enabled: true });

  const other = await memberCtx.post(
    `/api/${owner.orgSlug}/tools/ORGANIZATION_SETTINGS_UPDATE`,
    { data: { organizationId: orgId, flags: { auto_merge: true } } },
  );
  expect(other.ok()).toBe(false);

  const settings = await callSelfMcpTool<OrgSettings>(
    ownerCtx,
    owner.orgSlug,
    "ORGANIZATION_SETTINGS_GET",
    {},
  );
  expect(settings.flags?.new_blocks_editor).toBe(true);
  expect(settings.flags?.auto_merge).toBeUndefined();
});
