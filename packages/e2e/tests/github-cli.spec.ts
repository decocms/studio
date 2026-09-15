import { randomInt, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, newApiContext } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

const fixtureOrigin = `http://localhost:${process.env.GITHUB_STUB_PORT ?? "4102"}`;
const origin = process.env.BASE_URL ?? "http://localhost:4001";

async function cliState(state: {
  active: string;
  accounts: Record<string, string>;
  failure?: "empty" | "exit";
}) {
  await writeFile(
    join(process.env.GITHUB_CLI_E2E_HOME!, "fixture.json"),
    JSON.stringify(state),
  );
}

async function seed(request: APIRequestContext) {
  const login = `cli-${randomUUID().slice(0, 8)}`;
  const token = `synthetic-${randomUUID()}`;
  const id = randomInt(1, 1_000_000_001);
  const path = `${login}/example`;
  const repositories = [
    {
      id,
      full_name: path,
      private: true,
      html_url: `https://github.com/${path}`,
      default_branch: "main",
    },
  ];
  expect(
    (
      await request.post(`${fixtureOrigin}/__admin/github-users`, {
        data: {
          token,
          user: { id, login },
          installations: [],
          memberships: [],
          repositories,
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.post(`${fixtureOrigin}/__admin/repos`, {
        data: {
          owner: login,
          repo: "example",
          branches: {
            main: {
              files: { ".deco/blocks/Example.json": '{"title":"CLI import"}' },
            },
          },
        },
      })
    ).ok(),
  ).toBe(true);
  await cliState({ active: login, accounts: { [login]: token } });
  return { login, token, id, path };
}

async function connect(request: APIRequestContext, org: string) {
  const response = await request.post(
    `/api/${org}/git-providers/github/cli/connect`,
    { data: {}, headers: { Origin: origin } },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).account as { id: string; login: string };
}

test("CLI button connects, searches, links and disconnects without storing a token", async ({
  authedPage,
}, testInfo) => {
  const { page, orgSlug } = authedPage;
  const request = page.context().request;
  const user = await seed(request);
  await page.goto(`/${orgSlug}/settings/repositories`);
  const button = page.getByRole("button", {
    name: "Connect with GitHub CLI",
    exact: true,
  });
  await expect(button).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("github-cli-connect.png"),
  });
  await button.click();
  await expect(page.getByText(user.login, { exact: true })).toBeVisible();
  const account = await connect(request, orgSlug);
  expect(account.login).toBe(user.login);
  const listed = await callSelfMcpTool<{
    accounts: Array<{ id: string; authKind: string; servable: boolean }>;
  }>(request, orgSlug, "GIT_ACCOUNT_LIST", {});
  expect(listed.accounts).toMatchObject([
    { id: account.id, authKind: "github_cli", servable: true },
  ]);
  expect(listed.accounts).toHaveLength(1);
  const search = await callSelfMcpTool<{
    repositories: Array<{ ref: { path: string } }>;
  }>(request, orgSlug, "REPOSITORY_SEARCH", { accountId: account.id });
  expect(search.repositories).toMatchObject([{ ref: { path: user.path } }]);
  const { repository } = await callSelfMcpTool<{
    repository: { id: string; accountId: string };
  }>(request, orgSlug, "REPOSITORY_LINK", {
    accountId: account.id,
    url: `https://github.com/${user.path}`,
  });
  expect(repository.accountId).toBe(account.id);
  const { item: agent } = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "CLI import",
        connections: [],
        metadata: {
          previewServerUrl: "https://preview.example.com",
          githubRepo: {
            owner: user.login,
            name: "example",
            url: `https://github.com/${user.path}`,
            repositoryId: repository.id,
          },
        },
      },
    },
  );
  const content = await request.get(
    `/api/${orgSlug}/decofile/${agent.id}/main`,
  );
  expect(content.ok(), await content.text()).toBe(true);
  expect((await content.json()).decofile.Example).toEqual({
    title: "CLI import",
  });
  const db = await connectDevDb();
  try {
    const { rows } = await db.query(
      "SELECT a.external_account_id, c.account_id AS credential_id FROM git_provider_accounts a LEFT JOIN git_provider_account_credentials c ON c.account_id=a.id WHERE a.id=$1 AND a.organization_id=(SELECT id FROM organization WHERE slug=$2)",
      [account.id, orgSlug],
    );
    expect(rows).toEqual([
      { external_account_id: `cli:user:${user.id}`, credential_id: null },
    ]);
  } finally {
    await db.end();
  }
  await callSelfMcpTool(request, orgSlug, "GIT_ACCOUNT_DELETE", {
    id: account.id,
  });
  const remaining = await callSelfMcpTool<{
    repositories: Array<{ id: string; accountId: string | null }>;
  }>(request, orgSlug, "REPOSITORY_LIST", {});
  expect(remaining.repositories).toMatchObject([
    { id: repository.id, accountId: null },
  ]);
  await callSelfMcpTool(request, orgSlug, "COLLECTION_VIRTUAL_MCP_DELETE", {
    id: agent.id,
  });
});

test("keeps the selected account across CLI switches and refuses logout or identity changes", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const request = page.context().request;
  const original = await seed(request);
  const account = await connect(request, orgSlug);
  const other = await seed(request);
  await cliState({
    active: other.login,
    accounts: { [original.login]: original.token, [other.login]: other.token },
  });
  const search = () =>
    callSelfMcpTool<{ repositories: Array<{ ref: { path: string } }> }>(
      request,
      orgSlug,
      "REPOSITORY_SEARCH",
      { accountId: account.id },
    );
  expect((await search()).repositories).toMatchObject([
    { ref: { path: original.path } },
  ]);
  await cliState({
    active: other.login,
    accounts: { [other.login]: other.token },
  });
  await expect(search()).rejects.toThrow("gh auth login");
  await cliState({
    active: original.login,
    accounts: { [original.login]: other.token },
  });
  await expect(search()).rejects.toThrow("account changed");
});

test("CLI failures are actionable and do not expose subprocess output", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  for (const failure of ["empty", "exit"] as const) {
    await cliState({ active: "absent", accounts: {}, failure });
    const response = await page.request.post(
      `/api/${orgSlug}/git-providers/github/cli/connect`,
      { data: {}, headers: { Origin: origin } },
    );
    expect(response.status()).toBe(400);
    expect(await response.text()).toContain("gh auth login");
    expect(await response.text()).not.toContain("synthetic-secret");
  }
});

test("connect requires the local browser origin and organization membership", async ({
  authedPage,
  playwright,
}) => {
  const { page, orgSlug } = authedPage;
  const path = `/api/${orgSlug}/git-providers/github/cli/connect`;
  for (const badOrigin of ["https://untrusted.example", "null"]) {
    expect(
      (
        await page.request.post(path, {
          data: {},
          headers: { Origin: badOrigin },
        })
      ).status(),
    ).toBe(403);
  }
  const outsider = await newApiContext(playwright);
  try {
    await signUpViaApi(outsider);
    expect((await outsider.post(path, { data: {} })).status()).toBe(403);
  } finally {
    await outsider.dispose();
  }
});
