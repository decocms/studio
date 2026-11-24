/**
 * A bot in an outside channel connects an account to the person who writes
 * to it: the channels service opens a link, the person confirms it signed
 * in, and the service then gets a token that acts as them. Covers the
 * service routes, the connect page and the profile list together.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, getE2EAppOrigin, test } from "../fixtures/test";

const SERVICE = { Authorization: "Bearer e2e-channels-service-token" };

async function openLink(
  request: APIRequestContext,
  orgSlug: string,
  accountId: string,
  extra: Record<string, string> = {},
) {
  const res = await request.post(
    `/api/${orgSlug}/internal/channel-accounts/claims`,
    {
      headers: SERVICE,
      data: {
        channel: "slack",
        account_id: accountId,
        account_name: "Ana Example",
        account_where: "Example Workspace",
        return_url: `${getE2EAppOrigin()}/?connected=1`,
        ...extra,
      },
    },
  );
  expect(res.ok()).toBe(true);
  const { url } = (await res.json()) as { url: string };
  return new URL(url).pathname;
}

function askForToken(
  request: APIRequestContext,
  orgSlug: string,
  accountId: string,
) {
  return request.post(`/api/${orgSlug}/internal/channel-accounts/token`, {
    headers: SERVICE,
    data: { channel: "slack", account_id: accountId },
  });
}

test("a channel account is connected by the person, used by the service, and disconnected from the profile", async ({
  authedPage,
}) => {
  const { page, orgSlug, user } = authedPage;
  const request = page.context().request;
  const accountId = `T_E2E:${crypto.randomUUID()}`;

  expect((await askForToken(request, orgSlug, accountId)).status()).toBe(404);

  const link = await openLink(request, orgSlug, accountId);
  await page.goto(link);
  await expect(page.getByText("Ana Example")).toBeVisible();
  await expect(page.getByText("Slack · Example Workspace")).toBeVisible();
  await expect(
    page.getByText("Only continue if this account is yours"),
  ).toBeVisible();
  // The home route redirects on, so the return URL is only there for a moment.
  await Promise.all([
    page.waitForURL(/connected=1/, { waitUntil: "commit" }),
    page.getByRole("button", { name: "Connect", exact: true }).click(),
  ]);

  const token = await askForToken(request, orgSlug, accountId);
  expect(token.ok()).toBe(true);
  const body = (await token.json()) as {
    token: string;
    user: { email: string };
  };
  expect(body.user.email).toBe(user.email);
  // The token is the person: it lists their own accounts.
  const mine = await request.post(
    `/api/${orgSlug}/tools/CHANNEL_ACCOUNT_LIST`,
    { headers: { Authorization: `Bearer ${body.token}` }, data: {} },
  );
  expect(mine.ok()).toBe(true);

  // A link works once.
  await page.goto(link);
  await expect(page.getByText("Link unavailable")).toBeVisible();

  await page.goto(`/${orgSlug}/settings/profile`);
  await expect(page.getByText("Connected channel accounts")).toBeVisible();
  await expect(page.getByText("Ana Example")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(page.getByText("Connected channel accounts")).toHaveCount(0);
  expect((await askForToken(request, orgSlug, accountId)).status()).toBe(404);
});

test("a link naming another email connects nothing", async ({ authedPage }) => {
  const { page, orgSlug } = authedPage;
  const request = page.context().request;
  const accountId = `T_E2E:${crypto.randomUUID()}`;
  const link = await openLink(request, orgSlug, accountId, {
    account_email: "someone-else@example.com",
  });
  await page.goto(link);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByText("This channel account belongs to another email."),
  ).toBeVisible();
  expect((await askForToken(request, orgSlug, accountId)).status()).toBe(404);
});

test("the service's routes answer nobody without its secret", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const res = await page
    .context()
    .request.post(`/api/${orgSlug}/internal/channel-accounts/token`, {
      data: { channel: "slack", account_id: "T_E2E:any" },
    });
  expect(res.status()).toBe(401);
});
