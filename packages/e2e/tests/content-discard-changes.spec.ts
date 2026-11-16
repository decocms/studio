/**
 * E2E: a hosted v8 draft's "Changes in draft" list discards one entry's
 * changes from its row menu, back to the published copy, without deleting it
 * and without going through Publish.
 *
 * A published base (Home, About) and a draft over it that changes Home and
 * adds Fresh: only the changed row offers the discard, since a new entry has
 * no published copy to go back to.
 *
 * The list reads only the draft's index, so its rows are named by key.
 *
 * Wire-contract strings are inlined on purpose (see ban-e2e-app-imports).
 */

import type { APIRequestContext } from "@playwright/test";
import {
  createFastPreviewProject,
  setBlocksV8Site,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

const schema = {
  blocksMajor: 8,
  manifest: {
    blocks: { pages: { page: { $ref: "#/definitions/cGFnZQ==" } } },
  },
  schema: {
    definitions: {
      "cGFnZQ==": {
        type: "object",
        properties: {
          __resolveType: { type: "string", enum: ["page"] },
          path: { type: "string" },
          name: { type: "string" },
          sections: { type: "array", items: {} },
        },
      },
    },
  },
};

const page = (name: string, path: string) => ({
  __resolveType: "page",
  name,
  path,
  sections: [],
});

async function rpc(
  api: APIRequestContext,
  site: string,
  draft: string,
  method: string,
  params: object,
) {
  const response = await api.post(`/api/cms/${site}/drafts/${draft}/rpc`, {
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
  expect(response.ok()).toBe(true);
  const answer = await response.json();
  expect(answer.error).toBeUndefined();
  return answer.result;
}

async function createDraft(api: APIRequestContext, site: string, name: string) {
  const response = await api.post(`/api/cms/${site}/drafts`, {
    data: { name },
  });
  expect(response.ok()).toBe(true);
}

test("a changed entry's row menu discards its changes", async ({
  authedPage: { page: browser, orgSlug },
}) => {
  test.slow();
  const api = browser.request;
  const site = uniqueOwner();
  const project = await createFastPreviewProject(api, orgSlug, {
    owner: site,
    repo: "site",
    siteSlug: site,
    connectionUrl: "http://127.0.0.1:1/unused",
  });
  await setBlocksV8Site(api, orgSlug, project.vmcpId, true);
  expect(
    (await api.put(`/api/cms/${site}/schema`, { data: schema })).ok(),
  ).toBe(true);

  // The published base.
  await createDraft(api, site, "seed");
  await rpc(api, site, "seed", "blocks.apply", {
    set: { home: page("Home", "/"), about: page("About", "/about") },
    ifMatch: { home: null, about: null },
  });
  const published = await api.post(`/api/cms/${site}/drafts/seed/publish`, {
    data: { message: "base" },
  });
  expect(published.ok()).toBe(true);

  // The draft over it: Home changed, Fresh new.
  await createDraft(api, site, "draft");
  await rpc(api, site, "draft", "blocks.apply", {
    set: {
      home: page("Home edited", "/"),
      fresh: page("Fresh", "/fresh"),
    },
    ifMatch: { home: null, fresh: null },
  });

  const { item: thread } = await callSelfMcpTool<{
    item: { id: string; branch: string };
  }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
    data: { virtual_mcp_id: project.vmcpId, branch: "draft" },
  });
  expect(thread.branch).toBe("draft");

  await browser.goto(
    `/${orgSlug}/projects/${project.vmcpId}/site-editor/content?thread=${thread.id}&sidepanel=false`,
  );
  const panel = browser.getByTestId("main-panel");
  await panel
    .getByRole("button", { name: /Changes in draft/ })
    .click({ timeout: 60_000 });

  // An openable row is a button, not a row: matched by its element.
  const row = (name: string) => panel.locator("tr").filter({ hasText: name });
  const openMenu = (name: string) =>
    row(name).getByRole("button", { name: "More actions" }).click();
  const discardItem = browser.getByRole("menuitem", {
    name: "Discard changes",
  });

  // New in draft: nothing published to go back to.
  await openMenu("fresh");
  await expect(browser.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await expect(discardItem).toHaveCount(0);
  await browser.keyboard.press("Escape");

  await openMenu("home");
  await discardItem.click();
  const dialog = browser.getByRole("alertdialog");
  await expect(dialog).toContainText('Discard changes to "home"?');
  await dialog.getByRole("button", { name: "Discard changes" }).click();

  await expect(browser.getByText('Discarded changes to "home"')).toBeVisible();
  await expect(row("home")).toHaveCount(0);
  await expect(row("fresh")).toHaveCount(1);

  const after = await rpc(api, site, "draft", "cms.blocks", {
    names: ["home"],
  });
  expect(after.blocks.home).toEqual(page("Home", "/"));
});
