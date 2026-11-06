/**
 * Production is never edited from a Blocks v7 Fast Preview project: a draft IS
 * a git branch there, so a session on the default branch would save straight
 * to the live site. The API refuses those writes, and the version switcher
 * keeps the last draft (deleting it used to fall back to production).
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
    const api = page.request;
    // The decofile routes need a preview server configured, not running.
    const { project, owner, repo } = await createProject(
      api,
      orgSlug,
      "http://127.0.0.1:1",
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
  });

  test("the version switcher keeps the last draft", async ({
    authedPage: { page, orgSlug },
  }) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const site = await startPreviewSite();
    try {
      const { project } = await createProject(page.request, orgSlug, site.url);
      const { item: thread } = await callSelfMcpTool<{ item: { id: string } }>(
        page.request,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: project.vmcpId, branch: "draft" } },
      );
      await page.goto(
        `/${orgSlug}/projects/${project.vmcpId}/site-editor?thread=${thread.id}&sidepanel=false`,
      );

      const switcher = page.locator('[data-tour="tour-layout-branch-picker"]');
      const draftRow = (name: string) =>
        page.locator("div.group", {
          has: page.locator("button[aria-pressed]", { hasText: name }),
        });
      const deleteItem = page.getByRole("menuitem", { name: "Delete" });

      // The session's branch is listed as its first draft.
      await switcher.click({ timeout: 60_000 });
      await expect(draftRow("Draft 1")).toBeVisible();
      await draftRow("Draft 1")
        .getByRole("button", { name: "More actions" })
        .click();
      await expect(deleteItem).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByText("Keep at least one draft")).toBeVisible();
      // Escape closes the row's menu; the switcher stays open.
      await page.keyboard.press("Escape");
      await expect(deleteItem).toHaveCount(0);

      // With a second draft, either can go.
      const newDraft = page.getByRole("button", { name: "New draft" });
      await newDraft.click();
      await expect(newDraft).toHaveCount(0);
      await switcher.click();
      await expect(draftRow("Draft 2")).toBeVisible();
      await draftRow("Draft 1")
        .getByRole("button", { name: "More actions" })
        .click();
      await expect(deleteItem).not.toHaveAttribute("aria-disabled", "true");
      await expect(page.getByText("Keep at least one draft")).toHaveCount(0);
    } finally {
      await site.close();
    }
  });
});
