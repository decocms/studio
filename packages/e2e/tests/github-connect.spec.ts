import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test, newApiContext, type AuthedPage } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";

const fixtureOrigin = `http://localhost:${process.env.GITHUB_STUB_PORT ?? "4102"}`;
type Installation = {
  id: number;
  account: {
    id: number;
    login: string;
    type: "Organization" | "User";
    avatar_url: string | null;
  };
};
function installation(
  login: string,
  type: "Organization" | "User" = "Organization",
): Installation {
  return {
    id: Math.floor(Math.random() * 1_000_000_000) + 1,
    account: {
      id: Math.floor(Math.random() * 1_000_000_000) + 1,
      login,
      type,
      avatar_url: null,
    },
  };
}
async function grantAccess(
  request: APIRequestContext,
  token: string,
  installations: Installation[],
) {
  const result = await request.post(`${fixtureOrigin}/__admin/github-users`, {
    data: { token, installations },
  });
  expect(result.ok()).toBe(true);
}
async function seedFlow(
  { page, orgSlug, user }: AuthedPage,
  installations: Installation[] = [],
  expired = false,
) {
  const db = await connectDevDb();
  try {
    const {
      rows: [org],
    } = await db.query<{ id: string }>(
      "SELECT id FROM organization WHERE slug=$1",
      [orgSlug],
    );
    const id = randomUUID();
    const token = `synthetic-${randomUUID()}`;
    // Persist the public storage contract using the dedicated server's synthetic vault key.
    const key = createHash("sha256")
      .update("github-connect-e2e-encryption-key")
      .digest();
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(token), cipher.final()]);
    const encrypted = Buffer.concat([
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]).toString("base64");
    await db.query(
      "INSERT INTO github_connect_flows (id, organization_id, user_id, encrypted_access_token, expires_at) VALUES ($1,$2,$3,$4,$5)",
      [
        id,
        org!.id,
        user.userId,
        encrypted,
        new Date(Date.now() + (expired ? -60_000 : 600_000)),
      ],
    );
    await grantAccess(page.request, token, installations);
    return {
      id,
      token,
      orgId: org!.id,
      path: `/api/${orgSlug}/git-providers/github/flows/${id}`,
      url: `/${orgSlug}/settings/repositories?git_flow=${id}`,
    };
  } finally {
    await db.end();
  }
}

test("choose one account, show its Studio connector, and manage that installation in a new tab", async ({
  authedPage,
}, testInfo) => {
  const { page, user } = authedPage;
  const selected = installation("acme-studio");
  selected.account.avatar_url = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#143630"/><text x="24" y="33" text-anchor="middle" fill="white" font-family="sans-serif" font-size="30">a</text></svg>')}`;
  const unselected = installation("personal-projects", "User");
  const flow = await seedFlow(authedPage, [selected, unselected]);
  await page.goto(flow.url);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: selected.account.login }),
  ).toBeVisible();
  await expect(dialog).toContainText("Members with repository permissions");
  await expect(dialog.locator("img")).toHaveAttribute(
    "src",
    selected.account.avatar_url,
  );
  await page.screenshot({
    path: testInfo.outputPath("github-account-chooser.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: selected.account.login }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(`Connected by ${user.name}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(unselected.account.login, { exact: true }),
  ).toHaveCount(0);
  const manage = page.getByRole("link", {
    name: "Manage repository access",
    exact: true,
  });
  await expect(manage).toHaveAttribute("target", "_blank");
  const response = await page.request.get(
    (await manage.getAttribute("href"))!,
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe(
    `https://github.com/organizations/acme-studio/settings/installations/${selected.id}`,
  );
  const db = await connectDevDb();
  try {
    const saved = await db.query(
      "SELECT installation_id, created_by FROM git_provider_accounts WHERE organization_id=$1",
      [flow.orgId],
    );
    expect(saved.rows).toEqual([
      { installation_id: String(selected.id), created_by: user.userId },
    ]);
    expect(
      (
        await db.query(
          "SELECT id FROM github_connect_flows WHERE organization_id=$1 AND id=$2",
          [flow.orgId, flow.id],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await db.end();
  }
  expect((await page.request.get(flow.path)).status()).toBe(410);
  await page.screenshot({
    path: testInfo.outputPath("github-connected-account.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(manage).toBeVisible();
  const bounds = await manage.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole("heading", { name: "Connected accounts" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("github-connected-account-mobile.png"),
    animations: "disabled",
  });
});

test("installation in another tab refreshes the original chooser and closes the returned tab", async ({
  authedPage,
}, testInfo) => {
  const { page } = authedPage;
  const flow = await seedFlow(authedPage);
  await page.goto(`${flow.url}&git_error=no_installations`);
  const dialog = page.getByRole("dialog");
  const install = dialog.getByRole("link", {
    name: "Install on another account",
  });
  await expect(install).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const href = (await install.getAttribute("href"))!;
  expect(new URL(href, page.url()).searchParams.get("returnTo")).toContain(
    `git_flow=${flow.id}&git_return=true`,
  );
  const start = await page.request.get(href, { maxRedirects: 0 });
  expect(new URL(start.headers().location!).pathname).toBe(
    "/apps/studio-e2e/installations/new",
  );
  await page.screenshot({
    path: testInfo.outputPath("github-installation-step.png"),
    animations: "disabled",
  });
  const account = installation("new-organization");
  await grantAccess(page.request, flow.token, [account]);
  await page
    .context()
    .route("https://github.com/apps/studio-e2e/installations/new?*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "GitHub installation configured",
      }),
    );
  const popup = page.waitForEvent("popup");
  await install.click();
  const returned = await popup;
  await returned.waitForLoadState();
  const closed = returned.waitForEvent("close");
  await returned.goto(`${flow.url}&git_return=true`).catch((error: Error) => {
    if (!error.message.includes("closed")) throw error;
  });
  await closed;
  await expect(
    dialog.getByRole("button", { name: account.account.login }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: account.account.login }).click();
  await expect(dialog).toHaveCount(0);
});

test("check access recovers when GitHub stays on its settings page", async ({
  authedPage,
}) => {
  const { page } = authedPage;
  const flow = await seedFlow(authedPage);
  await page.goto(flow.url);
  await expect(
    page.getByRole("link", { name: "Install on another account" }),
  ).toBeVisible();
  const account = installation("manual-return", "User");
  await grantAccess(page.request, flow.token, [account]);
  await page.getByRole("button", { name: "Check access", exact: true }).click();
  await page
    .getByRole("button", { name: account.account.login, exact: true })
    .click();
  const manage = page.getByRole("link", { name: "Manage repository access" });
  await expect(manage).toBeVisible();
  const response = await page.request.get(
    (await manage.getAttribute("href"))!,
    { maxRedirects: 0 },
  );
  expect(response.headers().location).toBe(
    `https://github.com/settings/installations/${account.id}`,
  );
});

test("flow ownership, expiry, validation, and concurrent completion protect the saved account", async ({
  authedPage,
  playwright,
}) => {
  const { page, orgSlug } = authedPage;
  const account = installation("owned-organization");
  const flow = await seedFlow(authedPage, [account]);
  const outsider = await newApiContext(playwright);
  const db = await connectDevDb();
  try {
    const other = await signUpViaApi(outsider);
    // A second admin in this same Studio workspace still cannot consume this user's grant.
    await db.query(
      'INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1,$2,$3,$4,now())',
      [randomUUID(), flow.orgId, other.userId, "owner"],
    );
    for (const path of [
      flow.path,
      `/api/${other.orgSlug}/git-providers/github/flows/${flow.id}`,
    ]) {
      expect((await outsider.get(path)).status()).toBe(410);
      expect(
        (
          await outsider.post(path, { data: { installationId: account.id } })
        ).status(),
      ).toBe(410);
      expect((await outsider.delete(path)).status()).toBe(204);
    }
    expect(
      (
        await page.request.post(flow.path, {
          data: { installationId: account.id + 1 },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post(flow.path, { data: { installationId: "1" } })
      ).status(),
    ).toBe(400);
    expect(
      (
        await page.request.post(flow.path, {
          data: "installationId=1",
          headers: { "Content-Type": "text/plain" },
        })
      ).status(),
    ).toBe(415);
    const listed = await page.request.get(flow.path);
    expect(listed.headers()["cache-control"]).toBe("no-store");
    expect(await listed.text()).not.toContain(flow.token);
    const results = await Promise.all(
      [1, 2].map(() =>
        page.request.post(flow.path, { data: { installationId: account.id } }),
      ),
    );
    expect(results.map((r) => r.status()).sort()).toEqual([200, 410]);
    expect(
      (
        await db.query(
          "SELECT id FROM git_provider_accounts WHERE organization_id=$1",
          [flow.orgId],
        )
      ).rows,
    ).toHaveLength(1);
    // A later teammate reconnect does not rewrite the original connector.
    const teammate = await seedFlow({ page, user: other, orgSlug }, [account]);
    expect(
      (
        await outsider.post(teammate.path, {
          data: { installationId: account.id },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await db.query(
          "SELECT created_by FROM git_provider_accounts WHERE organization_id=$1",
          [flow.orgId],
        )
      ).rows[0].created_by,
    ).toBe(authedPage.user.userId);
  } finally {
    await outsider.dispose();
    await db.end();
  }
  const expired = await seedFlow(authedPage, [account], true);
  expect(
    (
      await page.request.post(expired.path, {
        data: { installationId: account.id },
      })
    ).status(),
  ).toBe(410);
  await page.goto(expired.url);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "expired",
  );
  await expect(
    page.getByRole("link", { name: "Try again", exact: true }),
  ).toBeVisible();
});

test("closing the chooser deletes the grant and a standalone return remains usable", async ({
  authedPage,
}) => {
  const { page } = authedPage;
  const flow = await seedFlow(authedPage, [installation("standalone-return")]);
  await page.goto(`${flow.url}&git_return=true`);
  await expect(
    page.getByRole("button", { name: "standalone-return", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await page.request.get(flow.path)).status()).toBe(410);
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
    page.getByRole("link", {
      name: "Add GitHub account or organization",
      exact: true,
    }),
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

test("OAuth creates an encrypted chooser grant, setup refreshes it, and restarting replaces abandoned flows", async ({
  authedPage,
}) => {
  const { page, orgSlug, user } = authedPage;
  const db = await connectDevDb();
  const account = installation("oauth-organization");
  const token = `synthetic-${randomUUID()}`;
  await grantAccess(page.request, token, [account]);
  async function exchange(state: string) {
    const code = randomUUID();
    expect(
      (
        await page.request.post(`${fixtureOrigin}/__admin/github-codes`, {
          data: { code, token },
        })
      ).ok(),
    ).toBe(true);
    const result = await page.request.get(
      `/api/_git/github/callback?state=${state}&code=${code}`,
      { maxRedirects: 0 },
    );
    expect(result.status()).toBe(302);
    const destination = new URL(result.headers().location!);
    expect(destination.searchParams.has("git_error")).toBe(false);
    expect(destination.searchParams.get("git_flow")).toBeTruthy();
    return destination;
  }
  async function start(returnTo: string) {
    const result = await page.request.get(
      `/api/${orgSlug}/git-providers/github/connect?returnTo=${encodeURIComponent(returnTo)}`,
      { maxRedirects: 0 },
    );
    return new URL(result.headers().location!).searchParams.get("state")!;
  }
  try {
    const {
      rows: [org],
    } = await db.query<{ id: string }>(
      "SELECT id FROM organization WHERE slug=$1",
      [orgSlug],
    );
    const destination = await exchange(
      await start(
        `/${orgSlug}/settings/repositories?git_error=no_installations`,
      ),
    );
    const id = destination.searchParams.get("git_flow")!;
    const before = await db.query(
      "SELECT * FROM github_connect_flows WHERE id=$1 AND organization_id=$2",
      [id, org!.id],
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0].user_id).toBe(user.userId);
    expect(before.rows[0].encrypted_access_token).not.toContain(token);
    const expiry = new Date(before.rows[0].expires_at).getTime();
    expect(expiry).toBeGreaterThan(Date.now());
    expect(expiry).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(
      (
        await db.query(
          "SELECT id FROM git_provider_accounts WHERE organization_id=$1",
          [org!.id],
        )
      ).rows,
    ).toEqual([]);
    destination.searchParams.set("git_return", "true");
    const install = await page.request.get(
      `/api/${orgSlug}/git-providers/github/install?returnTo=${encodeURIComponent(destination.pathname + destination.search)}`,
      { maxRedirects: 0 },
    );
    const installState = new URL(install.headers().location!).searchParams.get(
      "state",
    )!;
    const setup = await page.request.get(
      `/api/_git/github/setup?state=${installState}&installation_id=${account.id}`,
      { maxRedirects: 0 },
    );
    const setupState = new URL(setup.headers().location!).searchParams.get(
      "state",
    )!;
    const returned = await exchange(setupState);
    expect(returned.searchParams.get("git_flow")).toBe(id);
    expect(returned.searchParams.get("git_return")).toBe("true");
    const refreshed = await db.query(
      "SELECT encrypted_access_token, expires_at FROM github_connect_flows WHERE id=$1 AND organization_id=$2",
      [id, org!.id],
    );
    expect(new Date(refreshed.rows[0].expires_at).getTime()).toBe(expiry);
    expect(refreshed.rows[0].encrypted_access_token).not.toBe(
      before.rows[0].encrypted_access_token,
    );
    const again = await exchange(
      await start(`/${orgSlug}/settings/repositories`),
    );
    const nextId = again.searchParams.get("git_flow")!;
    expect(nextId).not.toBe(id);
    expect(
      (
        await db.query(
          "SELECT id FROM github_connect_flows WHERE organization_id=$1 AND user_id=$2",
          [org!.id, user.userId],
        )
      ).rows,
    ).toEqual([{ id: nextId }]);
    expect(
      (
        await page.request.get(
          `/api/${orgSlug}/git-providers/github/flows/${id}`,
        )
      ).status(),
    ).toBe(410);
    await page.goto(again.toString());
    await page
      .getByRole("button", { name: account.account.login, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByText(`Connected by ${user.name}`, { exact: true }),
    ).toBeVisible();
  } finally {
    await db.end();
  }
});

test("returning focus discovers new installation access without a callback or another authorization", async ({
  authedPage,
}) => {
  const { page } = authedPage;
  const flow = await seedFlow(authedPage);
  await page.goto(flow.url);
  await expect(
    page.getByRole("link", { name: "Install on another account" }),
  ).toBeVisible();
  const githubTab = await page.context().newPage();
  await githubTab.goto("about:blank");
  await githubTab.bringToFront();
  const account = installation("focus-return");
  await grantAccess(page.request, flow.token, [account]);
  await page.bringToFront();
  // Headless Chromium keeps both documents visible; deliver the browser focus event.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("button", { name: account.account.login, exact: true }),
  ).toBeVisible();
  await githubTab.close();
});
