/**
 * "Create a new site" under New project: a repository generated from a site
 * template in a connected GitHub account, linked, and opened as a project.
 *
 * GitHub is the suite's stub: the template repository is seeded there, and the
 * generated repository is read back from it to prove what Studio created.
 */

import { randomInt } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

const fixtureOrigin = `http://localhost:${process.env.GITHUB_STUB_PORT ?? "4102"}`;

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface LinkedRepository {
  id: string;
  accountId: string | null;
  path: string;
  visibility: string | null;
}

async function seedTemplate(request: APIRequestContext) {
  const res = await request.post(`${fixtureOrigin}/__admin/repos`, {
    data: {
      owner: "deco-sites",
      repo: "storefront-tanstack",
      branches: { main: { files: { "README.md": "storefront template" } } },
    },
  });
  expect(res.ok()).toBe(true);
}

/** A connected GitHub App account; `grant` null is the whole installation. */
async function seedAccount(
  request: APIRequestContext,
  orgSlug: string,
  userId: string,
  grant: number[] | null,
) {
  const orgId = await findOrgId(request, orgSlug);
  const installationId = randomInt(1, 1_000_000_000);
  const login = `site-owner-${installationId}`;
  const db = await connectDevDb();
  try {
    const saved = await db.query<{ id: string }>(
      `INSERT INTO git_provider_accounts (organization_id,type,host,auth_kind,external_account_id,login,installation_id,created_by,installation_authorized_by,installation_repository_ids) VALUES ($1,'github','github.com','github_app',$2,$3,$4,$5,'1001',$6) RETURNING id`,
      [
        orgId,
        String(installationId),
        login,
        installationId,
        userId,
        grant ? JSON.stringify(grant) : null,
      ],
    );
    return { orgId, accountId: saved.rows[0]!.id, login };
  } finally {
    await db.end();
  }
}

async function grantOf(accountId: string): Promise<number[] | null> {
  const db = await connectDevDb();
  try {
    const result = await db.query<{
      installation_repository_ids: number[] | null;
    }>(
      "SELECT installation_repository_ids FROM git_provider_accounts WHERE id=$1",
      [accountId],
    );
    return result.rows[0]?.installation_repository_ids ?? null;
  } finally {
    await db.end();
  }
}

async function stubRepo(request: APIRequestContext, path: string) {
  const res = await request.get(`${fixtureOrigin}/__admin/repos/${path}`);
  if (!res.ok()) return null;
  return (await res.json()) as {
    branches: Record<string, { files: Record<string, string> }>;
  };
}

test("New project creates a site from a template in the chosen GitHub account and opens it", async ({
  authedPage: { page, orgSlug, user },
}, testInfo) => {
  const request = page.context().request;
  await seedTemplate(request);
  const { orgId, accountId, login } = await seedAccount(
    request,
    orgSlug,
    user.userId,
    [424242],
  );
  await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: orgId,
    flags: { site_create_enabled: true },
  });

  await page.goto(`/${orgSlug}/home`);
  await page.getByRole("button", { name: "New Project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const shot = (name: string) =>
    page.screenshot({
      path: testInfo.outputPath(`create-site-${name}.png`),
      animations: "disabled",
    });
  const entry = dialog.getByRole("button", { name: /Create a new site/ });
  await expect(entry).toBeVisible();
  await shot("entry");
  await entry.click();
  await expect(
    dialog.getByRole("button", { name: /Storefront/ }),
  ).toBeVisible();
  await shot("template");
  await dialog.getByRole("button", { name: /Storefront/ }).click();
  await expect(
    dialog.getByRole("button", { name: new RegExp(login) }),
  ).toBeVisible();
  await shot("account");
  await dialog.getByRole("button", { name: new RegExp(login) }).click();

  const name = dialog.getByLabel("Site name");
  // Typed text is slugged; an invalid slug keeps the button off.
  await name.fill("My Store-");
  await expect(name).toHaveValue("my-store-");
  await expect(
    dialog.getByRole("button", { name: "Create site", exact: true }),
  ).toBeDisabled();
  await name.fill("my-store");
  await expect(
    dialog.getByText(`private repository ${login}/my-store`, { exact: false }),
  ).toBeVisible();
  await shot("name");
  await dialog
    .getByRole("button", { name: "Create site", exact: true })
    .click();
  await expect(dialog).not.toBeVisible({ timeout: 30_000 });

  // The template's files, in a repository owned by the chosen account.
  const created = await stubRepo(request, `${login}/my-store`);
  expect(created?.branches.main?.files).toEqual({
    "README.md": "storefront template",
  });

  const { repositories } = await callSelfMcpTool<{
    repositories: LinkedRepository[];
  }>(request, orgSlug, "REPOSITORY_LIST", {});
  const linked = repositories.find((r) => r.path === `${login}/my-store`);
  expect(linked).toMatchObject({ accountId, visibility: "private" });

  // The partial grant now covers the repository Studio created, and only it.
  const grant = await grantOf(accountId);
  expect(grant).toHaveLength(2);
  expect(grant?.[0]).toBe(424242);

  const { items } = await callSelfMcpTool<{
    items: Array<{
      title: string;
      description: string | null;
      metadata: { githubRepo?: { repositoryId: string } } | null;
    }>;
  }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_LIST", {});
  const project = items.filter(
    (item) => item.metadata?.githubRepo?.repositoryId === linked?.id,
  );
  expect(project).toHaveLength(1);
  expect(project[0]).toMatchObject({
    title: "my-store",
    description: "Created from the Storefront template",
  });
});

test("creating a site never adopts an existing repository or an unlisted template", async ({
  authedPage: { page, orgSlug, user },
}) => {
  const request = page.context().request;
  await seedTemplate(request);
  const { accountId, login } = await seedAccount(
    request,
    orgSlug,
    user.userId,
    null,
  );
  const create = (args: Record<string, unknown>) =>
    callSelfMcpTool<{ repository: LinkedRepository }>(
      request,
      orgSlug,
      "REPOSITORY_CREATE_FROM_TEMPLATE",
      { accountId, template: "storefront", ...args },
    );

  const { repository } = await create({ name: "twice" });
  expect(repository.path).toBe(`${login}/twice`);
  // A whole-installation grant stays whole.
  expect(await grantOf(accountId)).toBeNull();

  await expect(create({ name: "twice" })).rejects.toThrow(/already exists/);
  await expect(create({ name: "Not A Slug" })).rejects.toThrow();
  await expect(create({ name: "a".repeat(101) })).rejects.toThrow();
  await expect(
    create({ name: "elsewhere", template: "deco-sites/private-thing" }),
  ).rejects.toThrow();
  expect(await stubRepo(request, `${login}/elsewhere`)).toBeNull();
});
