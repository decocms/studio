import { expect, test } from "../fixtures/test";

test("an account with no GitHub installations can open installation settings from settings and the picker", async ({
  authedPage: { page, orgSlug },
}, testInfo) => {
  const returnTo = `/${orgSlug}/settings/repositories`;
  await page.goto(`${returnTo}?git_error=no_installations`);
  await expect(page.getByRole("alert")).toContainText(
    "GitHub authorization succeeded",
  );
  const manage = page.getByRole("link", {
    name: "Manage GitHub access",
    exact: true,
  });
  await expect(manage).toBeVisible();
  const href = await manage.getAttribute("href");
  expect(href).toBe(
    `/api/${orgSlug}/git-providers/github/install?returnTo=${encodeURIComponent(returnTo)}`,
  );
  const response = await page.request.get(href!, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  const destination = new URL(response.headers().location!);
  expect(destination.origin).toBe("https://github.com");
  expect(destination.pathname).toBe("/apps/studio-e2e/installations/new");
  expect(destination.searchParams.get("state")).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("github-installation-required.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Add repository", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("link", { name: "Manage GitHub access", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("github-picker-access.png"),
    animations: "disabled",
  });
});

test("reconnect asks which GitHub user to authorize and cancellation is visible", async ({
  authedPage: { page, orgSlug },
}) => {
  const returnTo = `/${orgSlug}/settings/repositories`;
  const response = await page.request.get(
    `/api/${orgSlug}/git-providers/github/connect?returnTo=${encodeURIComponent(returnTo)}`,
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(302);
  const destination = new URL(response.headers().location!);
  expect(destination.origin).toBe("https://github.com");
  expect(destination.searchParams.get("prompt")).toBe("select_account");
  const state = destination.searchParams.get("state");
  expect(state).toBeTruthy();
  await page.goto(
    `/api/_git/github/callback?state=${state}&error=access_denied`,
  );
  await expect(page.getByRole("alert")).toContainText(
    "Authorization was cancelled",
  );
  await expect(
    page.getByRole("link", { name: "Manage GitHub access", exact: true }),
  ).toBeVisible();
});

test("installation setup continues authorization with a fresh single-use state", async ({
  authedPage: { page, orgSlug },
}) => {
  const returnTo = `/${orgSlug}/settings/repositories`;
  const install = await page.request.get(
    `/api/${orgSlug}/git-providers/github/install?returnTo=${encodeURIComponent(returnTo)}`,
    { maxRedirects: 0 },
  );
  const state = new URL(install.headers().location!).searchParams.get("state");
  const setup = `/api/_git/github/setup?state=${state}&installation_id=123`;
  const response = await page.request.get(setup, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  const destination = new URL(response.headers().location!);
  expect(destination.pathname).toBe("/login/oauth/authorize");
  expect(destination.searchParams.has("prompt")).toBe(false);
  expect(destination.searchParams.get("state")).toBeTruthy();
  expect(destination.searchParams.get("state")).not.toBe(state);
  const replay = await page.request.get(setup, { maxRedirects: 0 });
  expect(
    new URL(replay.headers().location!).searchParams.get("git_error"),
  ).toBe("invalid_state");
});

test("unknown callback errors show a safe message and a successful return clears it", async ({
  authedPage: { page, orgSlug },
}) => {
  const returnTo = `/${orgSlug}/settings/repositories`;
  await page.goto(`${returnTo}?git_error=untrusted-provider-text`);
  await expect(page.getByRole("alert")).toContainText(
    "Could not connect your git account",
  );
  await expect(page.getByRole("alert")).not.toContainText(
    "untrusted-provider-text",
  );
  await page.goto(returnTo);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
