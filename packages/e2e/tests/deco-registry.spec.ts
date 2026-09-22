import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

test("the Deco catalog supports discovery without registry connections or private-registry tools", async ({
  playwright,
}) => {
  const api = await newApiContext(playwright);
  try {
    const owner = await signUpViaApi(api);
    const tool = (name: string, data: Record<string, unknown>) =>
      api.post(`/api/${owner.orgSlug}/tools/${name}`, { data });
    const response = await tool("COLLECTION_REGISTRY_APP_LIST", { limit: 1 });
    expect(response.status()).toBe(200);
    const page = await response.json();
    expect(page.items).toHaveLength(1);
    expect(page.totalCount).toBeGreaterThan(1);
    expect(page.nextCursor).toBeTruthy();
    const item = page.items[0];
    expect(item.server.name).toBeTruthy();

    const byId = await tool("COLLECTION_REGISTRY_APP_GET", { id: item.id });
    expect(byId.status()).toBe(200);
    expect((await byId.json()).item).toEqual(item);
    const byName = await tool("COLLECTION_REGISTRY_APP_GET", {
      name: item.server.name,
    });
    expect(byName.status()).toBe(200);
    expect((await byName.json()).item.id).toBe(item.id);

    const next = await tool("COLLECTION_REGISTRY_APP_LIST", {
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(next.status()).toBe(200);
    expect((await next.json()).items[0].id).not.toBe(item.id);

    const connections = await tool("COLLECTION_CONNECTIONS_LIST", {
      limit: 1000,
    });
    expect(connections.status()).toBe(200);
    const installed = (await connections.json()).items;
    expect(
      installed.some((connection: { app_name?: string }) =>
        ["deco-registry", "mcp-registry"].includes(connection.app_name ?? ""),
      ),
    ).toBe(false);

    for (const name of [
      "REGISTRY_ITEM_CREATE",
      "REGISTRY_PUBLISH_REQUEST_LIST",
      "REGISTRY_MONITOR_RUN_START",
      "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
    ]) {
      const removed = await tool(name, {});
      expect(removed.status()).toBe(404);
    }
  } finally {
    await api.dispose();
  }
});

test("catalog reads require authentication", async ({ playwright }) => {
  const ownerApi = await newApiContext(playwright);
  const api = await newApiContext(playwright);
  try {
    const owner = await signUpViaApi(ownerApi);
    const response = await api.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_REGISTRY_APP_LIST`,
      { data: {} },
    );
    expect(response.status()).toBe(403);
  } finally {
    await ownerApi.dispose();
    await api.dispose();
  }
});

test("Connections shows the Deco catalog without Store settings", async ({
  authedPage,
}, testInfo) => {
  const { page, orgSlug } = authedPage;
  const response = await page.request.post(
    `/api/${orgSlug}/tools/COLLECTION_REGISTRY_APP_LIST`,
    { data: { limit: 1 } },
  );
  expect(response.status()).toBe(200);
  const { items } = await response.json();
  await page.goto(`/${orgSlug}/settings/connections?tab=all`);
  const search = page.getByPlaceholder("Search for a connection");
  await expect(search).toBeVisible();
  await search.fill(items[0].title);
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText(items[0].title, { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator(`a[href="/${orgSlug}/settings/store"]`),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("deco-catalog.png"),
    fullPage: true,
  });
});
