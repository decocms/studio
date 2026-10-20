import { test, expect } from "../fixtures/test";

test("links and disconnects a personal Codex subscription through settings", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const endpoint = `/api/${orgSlug}/tools/CODEX_SUBSCRIPTION_STATUS`;
  const authJson = JSON.stringify({
    tokens: {
      access_token: "synthetic-access-example",
      refresh_token: "synthetic-refresh-example",
      id_token: "synthetic-id-example",
      account_id: "account_example",
    },
  });
  await page.goto(`/${orgSlug}/settings/ai-providers`);
  const card = page
    .getByText("Your ChatGPT subscription for Codex", { exact: true })
    .locator("../../..");
  const input = card.getByRole("textbox", {
    name: "Paste the contents of auth.json",
  });
  await expect(input).toBeVisible();
  await input.fill(authJson);
  await card.getByRole("button", { name: "Link", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveCount(0);

  const status = await page.context().request.post(endpoint, { data: {} });
  expect(status.ok()).toBe(true);
  const metadata = await status.json();
  expect(metadata).toMatchObject({ connected: true, expiresAt: null });
  expect(JSON.stringify(metadata)).not.toContain("synthetic-");
  expect(JSON.stringify(metadata)).not.toContain("tokens");

  await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(input).toBeVisible();
  const disconnected = await page
    .context()
    .request.post(endpoint, { data: {} });
  expect(disconnected.ok()).toBe(true);
  expect(await disconnected.json()).toMatchObject({ connected: false });
});
