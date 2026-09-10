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
import { callSelfMcpTool } from "../fixtures/mcp-tools";

const fixtureOrigin = `http://localhost:${process.env.GITHUB_STUB_PORT ?? "4102"}`;
type Installation = {
  id: number;
  account: {
    id: number;
    login: string;
    type: "Organization" | "User";
    avatar_url: string | null;
  };
  /** What the connecting user sees in the installation, and may install on. */
  repositories?: Array<{
    id: number;
    full_name?: string;
    permissions?: { admin?: boolean };
  }>;
};
function installation(
  login: string,
  type: "Organization" | "User" = "Organization",
  repositories?: Installation["repositories"],
): Installation {
  const id = Math.floor(Math.random() * 1_000_000_000) + 1;
  return {
    id,
    account: {
      id:
        type === "User" ? 1001 : Math.floor(Math.random() * 1_000_000_000) + 1,
      login,
      type,
      avatar_url: null,
    },
    repositories: (repositories ?? [{ id }]).map((repo) => ({
      ...repo,
      full_name: repo.full_name ?? `${login}/repo-${repo.id}`,
    })),
  };
}
async function grantAccess(
  request: APIRequestContext,
  token: string,
  installations: Installation[],
  identity?: {
    id?: number;
    memberships?: Array<{
      state: string;
      role: string;
      organization: { id: number };
    }>;
    identityStatus?: number;
    membershipsStatus?: number;
    repositoryDelayMs?: number;
  },
) {
  const result = await request.post(`${fixtureOrigin}/__admin/github-users`, {
    data: {
      token,
      installations: installations.map((item) => ({
        ...item,
        repositories: item.repositories?.map((repo) => ({
          ...repo,
          full_name: repo.full_name ?? `${item.account.login}/repo-${repo.id}`,
        })),
      })),
      user: { id: identity?.id ?? 1001, login: "connecting-user" },
      memberships:
        identity?.memberships ??
        installations
          .filter((item) => item.account.type === "Organization")
          .map((item) => ({
            state: "active",
            role: "admin",
            organization: { id: item.account.id },
          })),
      identityStatus: identity?.identityStatus,
      membershipsStatus: identity?.membershipsStatus,
      repositoryDelayMs: identity?.repositoryDelayMs,
    },
  });
  expect(result.ok()).toBe(true);
}
async function grantInput(
  request: APIRequestContext,
  path: string,
  installation: Installation,
  repositoryIds?: number[],
) {
  const choices = await request.get(
    `${path}/repositories?installationId=${installation.id}`,
  );
  const accountVersion = choices.ok()
    ? (await choices.json()).accountVersion
    : null;
  return {
    installationId: installation.id,
    repositoryIds: repositoryIds ??
      installation.repositories
        ?.filter((repo) => repo.permissions?.admin !== false)
        .map((repo) => repo.id) ?? [1],
    accountVersion,
  };
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
  await dialog.getByRole("checkbox").first().check();
  await dialog
    .getByRole("button", { name: "Authorize 1 repository", exact: true })
    .click();
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
  await expect
    .poll(async () => {
      const bounds = await manage.boundingBox();
      return bounds ? bounds.x + bounds.width : Infinity;
    })
    .toBeLessThanOrEqual(390);
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
  await dialog.getByRole("checkbox").first().check();
  await dialog
    .getByRole("button", { name: "Authorize 1 repository", exact: true })
    .click();
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
  await page.getByRole("dialog").getByRole("checkbox").first().check();
  await page
    .getByRole("button", { name: "Authorize 1 repository", exact: true })
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
          await outsider.post(path, {
            data: await grantInput(page.request, flow.path, account),
          })
        ).status(),
      ).toBe(410);
      expect((await outsider.delete(path)).status()).toBe(204);
    }
    expect(
      (
        await page.request.post(flow.path, {
          data: {
            installationId: account.id + 1,
            repositoryIds: [1],
            accountVersion: null,
          },
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
      [1, 2].map(async () =>
        page.request.post(flow.path, {
          data: await grantInput(page.request, flow.path, account),
        }),
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
          data: await grantInput(outsider, teammate.path, account),
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
        data: await grantInput(page.request, flow.path, account),
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
    await page.getByRole("dialog").getByRole("checkbox").first().check();
    await page
      .getByRole("button", { name: "Authorize 1 repository", exact: true })
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

test("access to a collaborator's personal installation does not authorize sharing that entire account", async ({
  authedPage,
}, testInfo) => {
  const ownOrg = installation("my-organization");
  // GitHub may list a personal installation because the user collaborates on
  // one repository. That is not authority over its owner's other repositories.
  const collaborator = installation("another-person", "User");
  collaborator.account.id = 2002;
  const flow = await seedFlow(authedPage, [ownOrg, collaborator]);
  const response = await authedPage.page.request.get(flow.path);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(
    body.installations.map((item: { login: string }) => item.login),
  ).not.toContain(collaborator.account.login);
  const connected = await authedPage.page.request.post(flow.path, {
    data: await grantInput(authedPage.page.request, flow.path, collaborator),
  });
  expect(connected.status()).toBe(403);
  await authedPage.page.addInitScript(() =>
    localStorage.setItem(
      "studio:user:preferences",
      JSON.stringify({ language: "pt-BR" }),
    ),
  );
  await authedPage.page.goto(flow.url);
  const dialog = authedPage.page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: ownOrg.account.login, exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(collaborator.account.login, { exact: true }),
  ).toHaveCount(0);
  await authedPage.page.screenshot({
    path: testInfo.outputPath("github-owner-chooser.png"),
    animations: "disabled",
  });
});

test("an organization member shares only the repositories they administer", async ({
  authedPage,
}) => {
  const { page } = authedPage;
  const owned = installation("owned-organization");
  // Administering a repository is exactly what GitHub asks for to install the
  // App on it, so it is enough to hand that repository to Studio — and only it.
  const member = installation("member-organization", "Organization", [
    { id: 5001, permissions: { admin: true } },
    { id: 5002, permissions: { admin: false } },
    { id: 5003, permissions: { admin: true } },
  ]);
  const pending = installation("pending-owner-organization", "Organization", [
    { id: 5004, permissions: { admin: false } },
  ]);
  const external = installation("external-organization");
  const personal = installation("my-personal-account", "User", [
    { id: 5005, permissions: { admin: true } },
  ]);
  const installations = [owned, member, pending, external, personal];
  const flow = await seedFlow(authedPage, installations);
  const memberships = [
    { state: "active", role: "admin", organization: { id: owned.account.id } },
    {
      state: "active",
      role: "member",
      organization: { id: member.account.id },
    },
    {
      state: "pending",
      role: "admin",
      organization: { id: pending.account.id },
    },
  ];
  await grantAccess(page.request, flow.token, installations, { memberships });
  const listed = await (await page.request.get(flow.path)).json();
  expect(listed.installations).toMatchObject([
    { login: owned.account.login, repositoryCount: null },
    { login: member.account.login, repositoryCount: 2 },
    { login: personal.account.login, repositoryCount: null },
  ]);
  for (const forbidden of [pending, external]) {
    expect(
      (
        await page.request.post(flow.path, {
          data: await grantInput(page.request, flow.path, forbidden, [
            forbidden.repositories?.[0]?.id ?? 1,
          ]),
        })
      ).status(),
    ).toBe(403);
  }
  // The check runs again at connect time, against fresh GitHub state: the
  // organization offered whole a moment ago is now not offered at all.
  await grantAccess(page.request, flow.token, installations, {
    memberships: [],
  });
  expect(
    (
      await page.request.post(flow.path, {
        data: await grantInput(page.request, flow.path, owned),
      })
    ).status(),
  ).toBe(403);
  // Losing the membership costs them nothing they administer, though.
  expect(
    (
      await page.request.post(flow.path, {
        data: await grantInput(page.request, flow.path, member),
      })
    ).status(),
  ).toBe(200);
  const db = await connectDevDb();
  try {
    const saved = await db.query<{ installation_repository_ids: number[] }>(
      "SELECT installation_repository_ids FROM git_provider_accounts WHERE organization_id=$1 AND external_account_id=$2",
      [flow.orgId, String(member.id)],
    );
    expect(saved.rows[0]?.installation_repository_ids).toEqual([5001, 5003]);
  } finally {
    await db.end();
  }
});

test("organization permission checks overlap with bounded concurrency", async ({
  authedPage,
}) => {
  const { page } = authedPage;
  const installations = Array.from({ length: 9 }, (_, index) =>
    installation(`member-org-${index}`, "Organization", [
      { id: 8000 + index, permissions: { admin: true } },
    ]),
  );
  const flow = await seedFlow(authedPage, installations);
  await grantAccess(page.request, flow.token, installations, {
    memberships: [],
    repositoryDelayMs: 100,
  });
  const response = await page.request.get(flow.path);
  expect(response.status()).toBe(200);
  expect(
    (await response.json()).installations.map(
      (item: { login: string }) => item.login,
    ),
  ).toEqual(installations.map((item) => item.account.login));
  const stats = await (
    await page.request.get(`${fixtureOrigin}/__admin/github-user-requests`, {
      headers: { Authorization: `Bearer ${flow.token}` },
    })
  ).json();
  expect(stats.peak).toBeGreaterThan(1);
  expect(stats.peak).toBeLessThanOrEqual(4);
});

test("connecting checks repositories only for the selected organization", async ({
  authedPage,
}) => {
  const { page } = authedPage;
  const installations = Array.from({ length: 6 }, (_, index) =>
    installation(`connect-org-${index}`, "Organization", [
      { id: 9000 + index, permissions: { admin: true } },
    ]),
  );
  const flow = await seedFlow(authedPage, installations);
  await grantAccess(page.request, flow.token, installations, {
    memberships: [],
  });
  const selected = installations[3]!;
  const repositoryPath = `/user/installations/${selected.id}/repositories?per_page=100&page=1`;
  const choices = await page.request.get(
    `${flow.path}/repositories?installationId=${selected.id}`,
  );
  expect(choices.status()).toBe(200);
  const selection = await choices.json();
  expect(selection.repositories.map((repo: { id: number }) => repo.id)).toEqual(
    [9003],
  );
  const beforeConnect = await (
    await page.request.get(`${fixtureOrigin}/__admin/github-user-requests`, {
      headers: { Authorization: `Bearer ${flow.token}` },
    })
  ).json();
  // Authority lookup and repository listing both stay within this installation.
  expect(
    beforeConnect.paths.filter((path: string) =>
      path.includes("/repositories?"),
    ),
  ).toEqual([repositoryPath, repositoryPath]);
  expect(
    (
      await page.request.post(flow.path, {
        data: {
          installationId: selected.id,
          repositoryIds: [9003],
          accountVersion: selection.accountVersion,
        },
      })
    ).status(),
  ).toBe(200);
  const stats = await (
    await page.request.get(`${fixtureOrigin}/__admin/github-user-requests`, {
      headers: { Authorization: `Bearer ${flow.token}` },
    })
  ).json();
  expect(
    stats.paths.filter((path: string) => path.includes("/repositories?")),
  ).toEqual([repositoryPath, repositoryPath, repositoryPath, repositoryPath]);
});

test("reconnecting replaces the repository selection and an owner remains scoped", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const org = installation("shared-organization", "Organization", [
    { id: 6001, permissions: { admin: true } },
    { id: 6002, permissions: { admin: false } },
  ]);
  const memberOnly = [
    { state: "active", role: "member", organization: { id: org.account.id } },
  ];
  const first = await seedFlow(authedPage, [org]);
  await grantAccess(page.request, first.token, [org], {
    memberships: memberOnly,
  });
  expect(
    (
      await page.request.post(first.path, {
        data: await grantInput(page.request, first.path, org, [6001]),
      })
    ).status(),
  ).toBe(200);

  const grant = async () => {
    const db = await connectDevDb();
    try {
      const row = await db.query<{ installation_repository_ids: number[] }>(
        "SELECT installation_repository_ids FROM git_provider_accounts WHERE organization_id=$1 AND external_account_id=$2",
        [first.orgId, String(org.id)],
      );
      return row.rows[0]?.installation_repository_ids ?? null;
    } finally {
      await db.end();
    }
  };
  expect(await grant()).toEqual([6001]);

  // A second person, administering the repository the first one could not.
  const second = await seedFlow(authedPage, []);
  await grantAccess(
    page.request,
    second.token,
    [
      {
        ...org,
        repositories: [{ id: 6002, permissions: { admin: true } }],
      },
    ],
    { id: 2002, memberships: memberOnly },
  );
  expect(
    (
      await page.request.post(second.path, {
        data: await grantInput(page.request, second.path, org, [6002]),
      })
    ).status(),
  ).toBe(200);
  expect(await grant()).toEqual([6002]);

  // An owner also has to choose; reconnecting must never widen to the whole installation.
  const third = await seedFlow(authedPage, []);
  await grantAccess(page.request, third.token, [org], {
    memberships: [
      { state: "active", role: "admin", organization: { id: org.account.id } },
    ],
  });
  expect(
    (
      await page.request.post(third.path, {
        data: await grantInput(page.request, third.path, org, [6001]),
      })
    ).status(),
  ).toBe(200);
  expect(await grant()).toEqual([6001]);
  const accounts = await callSelfMcpTool<{
    accounts: Array<{ login: string; servable: boolean }>;
  }>(page.request, orgSlug, "GIT_ACCOUNT_LIST", {});
  expect(accounts.accounts).toMatchObject([
    { login: org.account.login, servable: true },
  ]);
});

test("a partial grant reaches its repositories and nothing else in the installation", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const inside = { id: 7001, path: "grant-organization/administered" };
  const outside = { id: 7002, path: "grant-organization/not-administered" };
  for (const repo of [inside, outside]) {
    const [owner, name] = repo.path.split("/");
    const seeded = await page.request.post(`${fixtureOrigin}/__admin/repos`, {
      data: {
        owner,
        repo: name,
        id: repo.id,
        branches: { main: { files: { "README.md": repo.path } } },
      },
    });
    expect(seeded.ok()).toBe(true);
  }
  // Both repositories are in the installation; only one is theirs to authorize.
  const org = installation("grant-organization", "Organization", [
    { id: inside.id, permissions: { admin: true } },
    { id: outside.id, permissions: { admin: false } },
  ]);
  const flow = await seedFlow(authedPage, [org]);
  await grantAccess(page.request, flow.token, [org], {
    memberships: [
      { state: "active", role: "member", organization: { id: org.account.id } },
    ],
  });
  const connected = await page.request.post(flow.path, {
    data: await grantInput(page.request, flow.path, org),
  });
  expect(connected.status()).toBe(200);
  const { account } = (await connected.json()) as { account: { id: string } };

  const linked = await callSelfMcpTool<{
    repository: { path: string; externalId: string | null };
  }>(page.request, orgSlug, "REPOSITORY_LINK", {
    accountId: account.id,
    url: `https://github.com/${inside.path}`,
  });
  expect(linked.repository).toMatchObject({
    path: inside.path,
    externalId: String(inside.id),
  });
  await expect(
    callSelfMcpTool(page.request, orgSlug, "REPOSITORY_LINK", {
      accountId: account.id,
      url: `https://github.com/${outside.path}`,
    }),
  ).rejects.toThrow(/was not found|cannot access/);
});

test("owner lookup handles membership pagination and fails closed on GitHub errors", async ({
  authedPage,
}) => {
  const { page } = authedPage;
  const owned = installation("organization-after-page-one");
  const flow = await seedFlow(authedPage, [owned]);
  const memberships = Array.from({ length: 100 }, (_, i) => ({
    state: "active",
    role: "member",
    organization: { id: i + 1 },
  }));
  memberships.push({
    state: "active",
    role: "admin",
    organization: { id: owned.account.id },
  });
  await grantAccess(page.request, flow.token, [owned], { memberships });
  expect(
    (await (await page.request.get(flow.path)).json()).installations,
  ).toHaveLength(1);
  for (const failure of [{ identityStatus: 403 }, { membershipsStatus: 403 }]) {
    await grantAccess(page.request, flow.token, [owned], failure);
    expect((await page.request.get(flow.path)).status()).toBe(502);
    expect(
      (
        await page.request.post(flow.path, {
          data: await grantInput(page.request, flow.path, owned),
        })
      ).status(),
    ).toBe(502);
  }
  const accounts = await callSelfMcpTool<{ accounts: unknown[] }>(
    page.request,
    authedPage.orgSlug,
    "GIT_ACCOUNT_LIST",
    {},
  );
  expect(accounts.accounts).toEqual([]);
});

test("historical accounts cannot mint credentials until an owner reconnects, and revoked accounts stay blocked", async ({
  authedPage,
}) => {
  const { page, orgSlug, user } = authedPage;
  const owned = installation("previously-connected");
  const flow = await seedFlow(authedPage, [owned]);
  const db = await connectDevDb();
  try {
    const saved = await db.query<{ id: string }>(
      `INSERT INTO git_provider_accounts (organization_id,type,host,auth_kind,external_account_id,login,installation_id,created_by) VALUES ($1,'github','github.com','github_app',$2,$3,$4,$5) RETURNING id`,
      [
        flow.orgId,
        String(owned.id),
        owned.account.login,
        owned.id,
        user.userId,
      ],
    );
    const accountId = saved.rows[0]!.id;
    const list = () =>
      callSelfMcpTool<{ accounts: Array<{ id: string; servable: boolean }> }>(
        page.request,
        orgSlug,
        "GIT_ACCOUNT_LIST",
        {},
      );
    expect((await list()).accounts[0]?.servable).toBe(false);
    const linked = await db.query<{ id: string }>(
      `INSERT INTO repositories (organization_id,account_id,provider,host,path,web_url,visibility) VALUES ($1,$2,'github','github.com','previously-connected/private-project','https://github.com/previously-connected/private-project','private') RETURNING id`,
      [flow.orgId, accountId],
    );
    const repositoryId = linked.rows[0]!.id;
    const repositories = await callSelfMcpTool<{
      repositories: Array<{ id: string; usable: boolean }>;
    }>(page.request, orgSlug, "REPOSITORY_LIST", {});
    expect(repositories.repositories).toMatchObject([
      { id: repositoryId, usable: false },
    ]);
    await expect(
      callSelfMcpTool(page.request, orgSlug, "REPOSITORY_SEARCH_BRANCHES", {
        repositoryId,
        query: "",
      }),
    ).rejects.toThrow(/reconnect/i);
    await expect(
      callSelfMcpTool(page.request, orgSlug, "REPOSITORY_SEARCH", {
        accountId,
      }),
    ).rejects.toThrow("Reconnect this git account");
    await expect(
      callSelfMcpTool(page.request, orgSlug, "REPOSITORY_LINK", {
        accountId,
        url: "https://github.com/previously-connected/private-project",
      }),
    ).rejects.toThrow("Reconnect this git account");
    expect(
      (
        await page.request.post(flow.path, {
          data: await grantInput(page.request, flow.path, owned),
        })
      ).status(),
    ).toBe(200);
    expect((await list()).accounts).toMatchObject([
      { id: accountId, servable: true },
    ]);
    const proof = await db.query(
      "SELECT installation_authorized_by FROM git_provider_accounts WHERE id=$1 AND organization_id=$2",
      [accountId, flow.orgId],
    );
    expect(proof.rows[0].installation_authorized_by).toBe("1001");
    await db.query(
      "UPDATE git_provider_accounts SET status='revoked' WHERE id=$1 AND organization_id=$2",
      [accountId, flow.orgId],
    );
    expect((await list()).accounts[0]?.servable).toBe(false);
    await expect(
      callSelfMcpTool(page.request, orgSlug, "REPOSITORY_SEARCH", {
        accountId,
      }),
    ).rejects.toThrow("revoked");
  } finally {
    await db.end();
  }
});

test("an owner chooses one repository across pages and malformed or foreign selections never authorize an account", async ({
  authedPage,
}, testInfo) => {
  const { page } = authedPage;
  const baseId = Math.floor(Math.random() * 100_000_000) + 10_000;
  const repos = Array.from({ length: 101 }, (_, i) => ({ id: baseId + i }));
  const account = installation("selected-projects", "Organization", repos);
  const flow = await seedFlow(authedPage, [account]);
  const input = await grantInput(page.request, flow.path, account, [
    baseId + 100,
  ]);
  for (const repositoryIds of [
    undefined,
    null,
    [],
    [baseId, baseId],
    [0],
    [-1],
    [1.5],
    ["1"],
    Array.from({ length: 501 }, (_, i) => baseId + i),
  ]) {
    expect(
      (
        await page.request.post(flow.path, {
          data: { ...input, repositoryIds },
        })
      ).status(),
    ).toBe(400);
  }
  expect(
    (
      await page.request.post(flow.path, {
        data: { ...input, repositoryIds: [baseId, baseId + 200] },
      })
    ).status(),
  ).toBe(403);
  const accounts = await callSelfMcpTool<{ accounts: unknown[] }>(
    page.request,
    authedPage.orgSlug,
    "GIT_ACCOUNT_LIST",
    {},
  );
  expect(accounts.accounts).toEqual([]);
  await page.goto(flow.url);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: account.account.login, exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Authorize 0 repositories",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(dialog.getByRole("checkbox")).toHaveCount(100);
  await dialog
    .getByRole("button", { name: "Load more repositories", exact: true })
    .click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(101);
  await dialog.getByRole("checkbox").last().check();
  await page.screenshot({
    path: testInfo.outputPath("github-repository-consent.png"),
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Authorize 1 repository", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const db = await connectDevDb();
  try {
    const saved = await db.query(
      "SELECT installation_repository_ids FROM git_provider_accounts WHERE organization_id=$1",
      [flow.orgId],
    );
    expect(saved.rows).toEqual([
      { installation_repository_ids: [baseId + 100] },
    ]);
  } finally {
    await db.end();
  }
});

test("a repo admin cannot select a non-admin repository or retain permission lost after listing", async ({
  authedPage,
}) => {
  const { page } = authedPage;
  const account = installation("limited-selection", "Organization", [
    { id: 91001, permissions: { admin: true } },
    { id: 91002, permissions: { admin: true } },
    { id: 91003, permissions: { admin: false } },
  ]);
  const flow = await seedFlow(authedPage, [account]);
  await grantAccess(page.request, flow.token, [account], { memberships: [] });
  const path = `${flow.path}/repositories?installationId=${account.id}`;
  expect(
    (await (await page.request.get(path)).json()).repositories.map(
      (repo: { id: number }) => repo.id,
    ),
  ).toEqual([91001, 91002]);
  const input = await grantInput(
    page.request,
    flow.path,
    account,
    [91001, 91003],
  );
  expect((await page.request.post(flow.path, { data: input })).status()).toBe(
    403,
  );
  await grantAccess(
    page.request,
    flow.token,
    [
      {
        ...account,
        repositories: [
          { id: 91001, permissions: { admin: false } },
          { id: 91002, permissions: { admin: true } },
        ],
      },
    ],
    { memberships: [] },
  );
  expect(
    (
      await page.request.post(flow.path, {
        data: { ...input, repositoryIds: [91001] },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post(flow.path, {
        data: { ...input, repositoryIds: [91002] },
      })
    ).status(),
  ).toBe(200);
});

test("a narrowed legacy grant blocks linked repos and a stale chooser cannot restore access", async ({
  authedPage,
  playwright,
}) => {
  const { page, orgSlug } = authedPage;
  const suffix = randomUUID().slice(0, 8);
  const repoId = Math.floor(Math.random() * 100_000_000) + 1;
  const account = installation(`workspace-${suffix}`, "Organization", [
    { id: repoId },
    { id: repoId + 1 },
  ]);
  const kept = `${account.account.login}/kept`;
  const removed = `${account.account.login}/removed`;
  for (const [i, path] of [kept, removed].entries()) {
    const [owner, repo] = path.split("/");
    expect(
      (
        await page.request.post(`${fixtureOrigin}/__admin/repos`, {
          data: {
            owner,
            repo,
            id: repoId + i,
            branches: { main: { files: { "README.md": "Synthetic fixture" } } },
          },
        })
      ).ok(),
    ).toBe(true);
  }
  const initial = await seedFlow(authedPage, [account]);
  const response = await page.request.post(initial.path, {
    data: await grantInput(page.request, initial.path, account),
  });
  expect(response.status()).toBe(200);
  const accountId = (await response.json()).account.id;
  const linked = await callSelfMcpTool<{ repository: { id: string } }>(
    page.request,
    orgSlug,
    "REPOSITORY_LINK",
    {
      accountId,
      url: `https://github.com/${removed}`,
    },
  );
  const teammate = await newApiContext(playwright);
  const other = await signUpViaApi(teammate);
  const db = await connectDevDb();
  try {
    await db.query(
      'INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1,$2,$3,$4,now())',
      [randomUUID(), initial.orgId, other.userId, "owner"],
    );
    // Seed the historical whole-installation contract, then narrow through the real API.
    await db.query(
      "UPDATE git_provider_accounts SET installation_repository_ids=NULL, updated_at=now() WHERE id=$1 AND organization_id=$2",
      [accountId, initial.orgId],
    );
    const first = await seedFlow(authedPage, [account]);
    const second = await seedFlow({ ...authedPage, user: other }, [account]);
    const narrow = await grantInput(page.request, first.path, account, [
      repoId,
    ]);
    const stale = await grantInput(teammate, second.path, account);
    expect(
      (await page.request.post(first.path, { data: narrow })).status(),
    ).toBe(200);
    expect((await teammate.post(second.path, { data: stale })).status()).toBe(
      409,
    );
    expect((await teammate.get(second.path)).status()).toBe(200);
    const saved = await db.query(
      "SELECT installation_repository_ids FROM git_provider_accounts WHERE id=$1 AND organization_id=$2",
      [accountId, initial.orgId],
    );
    expect(saved.rows).toEqual([{ installation_repository_ids: [repoId] }]);
    await expect(
      callSelfMcpTool(page.request, orgSlug, "REPOSITORY_LINK", {
        accountId,
        url: `https://github.com/${removed}`,
      }),
    ).rejects.toThrow(/was not found|cannot access/);
    await expect(
      callSelfMcpTool(page.request, orgSlug, "REPOSITORY_SEARCH_BRANCHES", {
        repositoryId: linked.repository.id,
        query: "",
      }),
    ).rejects.toThrow();
    const visible = await callSelfMcpTool<{
      repositories: Array<{ id: string; usable: boolean }>;
    }>(page.request, orgSlug, "REPOSITORY_LIST", {});
    expect(visible.repositories).toContainEqual(
      expect.objectContaining({ id: linked.repository.id, usable: false }),
    );
    const allowed = await callSelfMcpTool<{ repository: { path: string } }>(
      page.request,
      orgSlug,
      "REPOSITORY_LINK",
      { accountId, url: `https://github.com/${kept}` },
    );
    expect(allowed.repository.path).toBe(kept);
    const third = await seedFlow(authedPage, [account]);
    const thirdInput = await grantInput(page.request, third.path, account, [
      repoId,
    ]);
    const refreshed = await grantInput(teammate, second.path, account);
    const raced = await Promise.all([
      page.request.post(third.path, { data: thirdInput }),
      teammate.post(second.path, { data: refreshed }),
    ]);
    expect(raced.map((result) => result.status()).sort()).toEqual([200, 409]);
  } finally {
    await db.end();
    await teammate.dispose();
  }
});
