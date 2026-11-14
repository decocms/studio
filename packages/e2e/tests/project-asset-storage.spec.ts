import { expect, newApiContext, test } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import type { APIRequestContext } from "@playwright/test";

test.setTimeout(120_000);

async function createStorage(request: APIRequestContext, orgSlug: string) {
  return callSelfMcpTool<{ id: string; name: string }>(
    request,
    orgSlug,
    "FILE_CONFIG_CREATE",
    {
      name: `media-${crypto.randomUUID()}`,
      bucket: "example-media",
      region: "us-east-1",
      accessKeyId: "example-access-key",
      secretAccessKey: "example-secret-key",
      publicUrlBase: "https://cdn.example.com",
    },
  );
}

const projectData = () => ({
  title: `Project ${crypto.randomUUID()}`,
  description: "Asset storage selection",
  status: "active",
  connections: [],
});

test("project asset storage persists, reports deletion, and can return to automatic", async ({
  authedPage: { page, orgSlug },
}, testInfo) => {
  const request = page.context().request;
  const storage = await createStorage(request, orgSlug);
  const { item } = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    { data: projectData() },
  );
  const readSelection = async () => {
    const { item: saved } = await callSelfMcpTool<{
      item: { metadata?: { assetStorageConfigId?: string | null } };
    }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_GET", { id: item.id });
    return saved.metadata?.assetStorageConfigId;
  };
  await page.goto(`/${orgSlug}/projects/${item.id}/settings`);
  const select = page.getByRole("combobox", {
    name: "Asset storage",
    exact: true,
  });
  await expect(select).toBeEnabled({ timeout: 60_000 });
  await select.click();
  await page.getByRole("option", { name: storage.name, exact: true }).click();
  await expect.poll(readSelection).toBe(storage.id);
  await page.reload();
  await expect(select).toHaveText(storage.name);
  await page.screenshot({
    path: testInfo.outputPath("project-asset-storage.png"),
    animations: "disabled",
  });

  await callSelfMcpTool(request, orgSlug, "FILE_CONFIG_DELETE", {
    id: storage.id,
  });
  await page.reload();
  await expect(select).toContainText(
    "The selected asset storage is unavailable",
  );
  await select.click();
  await page
    .getByRole("option", { name: "Automatic (match the site)", exact: true })
    .click();
  await expect.poll(readSelection).toBeNull();
  await page.reload();
  await expect(select).toHaveText("Automatic (match the site)");
});

test("project storage rejects another organization's configuration on create and update", async ({
  authedPage: { page, orgSlug },
  playwright,
}) => {
  const request = page.context().request;
  const other = await newApiContext(playwright);
  try {
    const otherUser = await signUpViaApi(other);
    const foreignStorage = await createStorage(other, otherUser.orgSlug);
    const metadata = { assetStorageConfigId: foreignStorage.id };
    await expect(
      callSelfMcpTool(request, orgSlug, "COLLECTION_VIRTUAL_MCP_CREATE", {
        data: { ...projectData(), metadata },
      }),
    ).rejects.toThrow(/not found/i);
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: projectData() },
    );
    await expect(
      callSelfMcpTool(request, orgSlug, "COLLECTION_VIRTUAL_MCP_UPDATE", {
        id: item.id,
        data: { metadata },
      }),
    ).rejects.toThrow(/not found/i);
    const saved = await callSelfMcpTool<{
      item: { metadata?: { assetStorageConfigId?: string | null } };
    }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_GET", { id: item.id });
    expect(saved.item.metadata?.assetStorageConfigId).toBeFalsy();
  } finally {
    await other.dispose();
  }
});
