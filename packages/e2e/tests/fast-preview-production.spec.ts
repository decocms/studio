/**
 * Production is read-only in a Blocks v7 Fast Preview project: a draft IS a
 * git branch there, so a session on the default branch would save straight to
 * the live site. The API refuses those writes, and the site editor on
 * production shows only a way to start a draft.
 *
 * The repo comes from the local Git Data stub and the site from
 * `startPreviewSite`.
 */

import type { APIRequestContext } from "@playwright/test";
import {
  createFastPreviewProject,
  inspectStubRepo,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { startPreviewSite } from "../fixtures/preview-site";
import { expect, test } from "../fixtures/test";

const NOTICE_TITLE = "Production can't be edited here";
const HOME = {
  __resolveType: "website/pages/Page.tsx",
  name: "Home",
  path: "/",
  sections: [],
};

async function createProject(
  api: APIRequestContext,
  orgSlug: string,
  previewServerUrl: string,
) {
  const owner = uniqueOwner();
  const repo = "production-read-only";
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
              },
            },
            schema: {
              definitions: { Page: { type: "object", properties: {} } },
            },
          }),
          ".deco/blocks/home.json": JSON.stringify(HOME),
        },
      },
      draft: null,
    },
  });
  return { project, owner, repo };
}

test.describe("Fast Preview production", () => {
  test.setTimeout(120_000);

  test("the API refuses a write to the default branch and still writes a draft", async ({
    authedPage: { page, orgSlug },
  }) => {
    const site = await startPreviewSite();
    try {
      const api = page.request;
      const { project, owner, repo } = await createProject(
        api,
        orgSlug,
        site.url,
      );
      const before = await inspectStubRepo(api, owner, repo);
      const edit = { set: { home: { ...HOME, name: "Edited" } } };

      const refused = await api.patch(
        `/api/${orgSlug}/decofile/${project.vmcpId}/main`,
        { data: edit },
      );
      expect(refused.status()).toBe(409);
      expect(await refused.json()).toMatchObject({
        code: "default_branch_read_only",
      });
      const after = await inspectStubRepo(api, owner, repo);
      expect(after.refs["main"]).toBe(before.refs["main"]);

      const draft = await api.patch(
        `/api/${orgSlug}/decofile/${project.vmcpId}/draft`,
        { data: edit },
      );
      expect(draft.status()).toBe(200);
    } finally {
      await site.close();
    }
  });

  test("the site editor on production shows only a way to start a draft", async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const site = await startPreviewSite();
    try {
      const api = page.request;
      const { project, owner, repo } = await createProject(
        api,
        orgSlug,
        site.url,
      );
      const before = await inspectStubRepo(api, owner, repo);
      const { item: thread } = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: project.vmcpId, branch: "main" } },
      );
      await page.goto(
        `/${orgSlug}/projects/${project.vmcpId}/site-editor?thread=${thread.id}&sidepanel=false`,
      );

      await expect(page.getByText(NOTICE_TITLE)).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByTestId("preview-page-picker")).toHaveCount(0);
      await expect(page.getByTestId("blocks-panel")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("production-notice.png"),
        animations: "disabled",
      });

      await page.getByRole("button", { name: "New draft" }).click();
      await expect(page.getByText(NOTICE_TITLE)).toHaveCount(0);
      await expect(page.getByTestId("preview-page-picker")).toBeVisible({
        timeout: 60_000,
      });

      // Opening production wrote nothing to it.
      const after = await inspectStubRepo(api, owner, repo);
      expect(after.refs["main"]).toBe(before.refs["main"]);
    } finally {
      await site.close();
    }
  });
});
