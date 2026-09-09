import { connectDevDb } from "../fixtures/db";
import { findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Self-contained, synthetic images keep this UI check independent of providers.
const organizationAvatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#4338ca"/><path d="M16 42V24l16-9 16 9v18l-16 9z" fill="white"/></svg>')}`;
const userAvatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#047857"/><circle cx="32" cy="24" r="11" fill="white"/><path d="M12 60v-6a20 20 0 0 1 40 0v6" fill="white"/></svg>')}`;

test("account avatars appear in settings and the picker, with fallbacks for missing and broken images", async ({
  authedPage: { page, orgSlug, user },
}, testInfo) => {
  const orgId = await findOrgId(page.request, orgSlug);
  const db = await connectDevDb();
  try {
    for (const account of [
      {
        provider: "github",
        login: "example-organization",
        avatar: organizationAvatar,
      },
      { provider: "gitlab", login: "example-user", avatar: userAvatar },
      { provider: "gitlab", login: "missing-avatar", avatar: null },
      {
        provider: "gitlab",
        login: "broken-avatar",
        avatar: "data:image/png;base64,invalid-image",
      },
    ]) {
      await db.query(
        `INSERT INTO git_provider_accounts
          (organization_id, type, host, auth_kind, external_account_id, login, avatar_url, installation_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
        [
          orgId,
          account.provider,
          `${account.provider}.com`,
          account.provider === "github" ? "github_app" : "token",
          account.login,
          account.avatar,
          account.provider === "github" ? 123 : null,
          account.login.startsWith("example-") ? user.userId : null,
        ],
      );
    }
  } finally {
    await db.end();
  }

  await page.goto(`/${orgSlug}/settings/repositories`);
  const accounts = page.getByTestId("git-accounts-list");
  await expect(accounts.getByText("example-user", { exact: true })).toBeVisible(
    { timeout: 15000 },
  );
  await expect(
    accounts.getByText(`Connected by ${user.name}`, { exact: true }),
  ).toHaveCount(2);
  await expect(
    accounts.getByText("Connected by an unavailable user", { exact: true }),
  ).toHaveCount(2);
  await expect(accounts.getByRole("img")).toHaveCount(2);
  await expect(accounts.locator("img").nth(0)).toHaveAttribute(
    "src",
    organizationAvatar,
  );
  await expect(accounts.locator("img").nth(1)).toHaveAttribute(
    "src",
    userAvatar,
  );
  await expect(
    accounts.locator('[data-slot="avatar-fallback"] svg'),
  ).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("connected-account-avatars.png"),
    animations: "disabled",
  });

  await page
    .getByRole("button", { name: "Add repository", exact: true })
    .click();
  const picker = page.getByRole("dialog");
  const userRow = picker.getByRole("button", { name: /example-user/ });
  await expect(userRow.getByRole("img")).toHaveAttribute("src", userAvatar);
  for (const login of ["missing-avatar", "broken-avatar"]) {
    const row = picker.getByRole("button", { name: new RegExp(login) });
    await expect(row.getByRole("img")).toHaveCount(0);
    await expect(
      row.locator('[data-slot="avatar-fallback"] svg'),
    ).toBeVisible();
  }
  await page.screenshot({
    path: testInfo.outputPath("picker-account-avatars.png"),
    animations: "disabled",
  });
  await userRow.click();
  await expect(picker.getByRole("img")).toHaveAttribute("src", userAvatar);
  await picker.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    picker.getByRole("button", { name: /example-user/ }).getByRole("img"),
  ).toHaveAttribute("src", userAvatar);
});
