/**
 * The Loaders tab of the CMS Content browser: opening a loader replaces the
 * folder browser outright, so the editor has to offer its own way back — and it
 * has to name the list it actually returns to, which is the folder the loader
 * was opened from, not the collection root.
 *
 * The repo (manifest + blocks) comes from the local Git Data stub and the site
 * from `startPreviewSite`.
 */

import type { APIRequestContext } from "@playwright/test";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { startPreviewSite } from "../fixtures/preview-site";
import { expect, test } from "../fixtures/test";

const LOADER_RESOLVE_TYPE = "site/loaders/Products.ts";

async function createProject(
  api: APIRequestContext,
  orgSlug: string,
  previewServerUrl: string,
) {
  const owner = uniqueOwner();
  const repo = "loader-editor";
  const project = await createFastPreviewProject(api, orgSlug, {
    owner,
    repo,
    connectionUrl: "http://127.0.0.1:1/unused",
    previewServerUrl,
  });
  await seedStubRepo(api, {
    owner,
    repo,
    defaultBranch: "main",
    branches: {
      main: {
        files: {
          ".deco/meta.gen.json": JSON.stringify({
            manifest: {
              blocks: {
                pages: {
                  "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
                },
                loaders: {
                  [LOADER_RESOLVE_TYPE]: { $ref: "#/definitions/Products" },
                },
              },
            },
            schema: {
              definitions: {
                Page: { type: "object", properties: {} },
                Products: {
                  type: "object",
                  title: "Products",
                  properties: { query: { type: "string", title: "Query" } },
                },
              },
            },
          }),
          ".deco/blocks/home.json": JSON.stringify({
            __resolveType: "website/pages/Page.tsx",
            name: "Home",
            path: "/",
            sections: [],
          }),
        },
      },
    },
  });
  const { item: thread } = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: project.vmcpId, branch: "main" } },
  );
  return {
    url: `/${orgSlug}/projects/${project.vmcpId}/site-editor/content?thread=${thread.id}&sidepanel=false`,
  };
}

test.describe("CMS loader editor", () => {
  test.setTimeout(120_000);

  test("leads back to the folder the loader was opened from", async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const site = await startPreviewSite();
    try {
      const { url } = await createProject(page.request, orgSlug, site.url);
      await page.goto(url);

      // Advanced → Loaders → the `site` folder → the loader itself.
      await page
        .getByRole("button", { name: "Advanced", exact: true })
        .click({ timeout: 60_000 });
      await page.getByRole("button", { name: /^Loaders/ }).click();
      await page.getByRole("button", { name: "site 1 loader" }).click();
      await page.getByRole("button", { name: /^Products/ }).click();

      // The editor replaced the list, so the way back is its own control — and
      // it names the folder it returns to, not the collection root.
      const back = page.getByRole("button", { name: "site", exact: true });
      await expect(back).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("loader-editor-back.png"),
        animations: "disabled",
      });

      await back.click();
      await expect(
        page.getByRole("button", { name: /^Products/ }),
      ).toBeVisible();
      const trail = page.getByRole("navigation", { name: "Folder breadcrumb" });
      await expect(trail.getByRole("button")).toHaveText(["Loaders", "site"]);
    } finally {
      await site.close();
    }
  });
});
