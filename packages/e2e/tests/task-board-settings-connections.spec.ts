import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../fixtures/test-mcp-server";

let mcp: TestMcpServer;
test.beforeAll(async () => {
  mcp = await startTestMcpServer();
});
test.afterAll(async () => {
  await mcp?.stop();
});

test("task-board settings recover from a failed connection list", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const request = page.context().request;
  const orgResponse = await request.get("/api/auth/organization/list");
  expect(orgResponse.ok()).toBe(true);
  const orgs: Array<{ id: string; slug: string }> = await orgResponse.json();
  const org = orgs.find((org) => org.slug === orgSlug);
  if (!org) throw new Error("Test organization not found");
  await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: org.id,
    flags: { coding_agent_org_mcps: true },
  });
  await createHttpConnection(request, orgSlug, {
    title: "Example MCP",
    url: mcp.url,
  });

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const listUrl = `**/api/${orgSlug}/tools/COLLECTION_CONNECTIONS_LIST`;
  await page.route(listUrl, (route) => route.abort("failed"));
  await page.goto(`/${orgSlug}/settings/task-board`);

  const loadError = page.getByText("Could not load MCP connections");
  const orgMcps = page.getByRole("switch", {
    name: "Give runs this org's MCP connections",
  });
  await expect(loadError).toBeVisible();
  await expect(orgMcps).toBeEnabled();

  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(loadError).toBeVisible();
  await expect(orgMcps).toBeEnabled();

  await page.unroute(listUrl);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Let runs reach Example MCP" }),
  ).toBeChecked();
  await expect(loadError).toHaveCount(0);
  expect(
    errors.filter((message) =>
      /undefined.*filter|filter.*undefined/.test(message),
    ),
  ).toEqual([]);
});
