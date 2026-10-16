/**
 * E2E: the Fast Preview publish dialog warns about values the draft would
 * replace on the live site.
 *
 * A draft that started before someone else published keeps its own version of
 * every value both changed when it syncs and publishes. The dialog lists those
 * values (block and field) before the user commits to that, and stays quiet
 * when the two edits touched different values.
 *
 * Setup mirrors `cms-publish-surface`: all GitHub git traffic lands on the
 * local Git Data stub. Wire-contract strings are inlined on purpose — this
 * suite owns its contract (see ban-e2e-app-imports).
 */

import type { APIRequestContext } from "@playwright/test";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

const SHELL_TIMEOUT_MS = 60_000;
const REVIEW_AND_PUBLISH = "Review & Publish";
const OVERWRITES_TITLE =
  "Publishing replaces values that changed on the live site after this draft started:";

const header = { title: "Spring sale", label: "SSRio", collection: "680" };
const blockFile = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function openDraftWith(
  api: APIRequestContext,
  orgSlug: string,
  edits: { live: unknown; draft: unknown },
) {
  const owner = uniqueOwner();
  const repo = "site";
  const project = await createFastPreviewProject(api, orgSlug, {
    owner,
    repo,
    connectionUrl: "http://127.0.0.1:1/unused",
  });
  await seedStubRepo(api, {
    owner,
    repo,
    defaultBranch: "main",
    branches: {
      main: { files: { ".deco/blocks/Header.json": blockFile(header) } },
      draft: { files: { ".deco/blocks/Header.json": blockFile(header) } },
    },
  });
  const write = async (branch: string, value: unknown) => {
    const res = await api.patch(
      `/api/${orgSlug}/decofile/${project.vmcpId}/${branch}`,
      { data: { set: { Header: value } } },
    );
    expect(res.ok()).toBe(true);
  };
  // Someone publishes after this draft started; then the draft is edited.
  await write("main", edits.live);
  await write("draft", edits.draft);

  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: project.vmcpId, branch: "draft" } },
  );
  return `/${orgSlug}/${thread.item.id}?virtualmcpid=${project.vmcpId}&main=preview`;
}

test.describe("CMS publish overwrite warning", () => {
  test("lists the values the draft would replace on the live site", async ({
    authedPage,
  }) => {
    test.slow();
    const { page, orgSlug } = authedPage;
    const url = await openDraftWith(page.context().request, orgSlug, {
      live: { ...header, title: "Summer sale", label: "SS Rio" },
      draft: { ...header, title: "Winter sale", collection: "667" },
    });
    await page.goto(url);
    await page
      .getByRole("button", { name: REVIEW_AND_PUBLISH, exact: true })
      .click({ timeout: SHELL_TIMEOUT_MS });

    const warning = page.getByTestId("publish-overwrites");
    await expect(warning).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(warning).toContainText(OVERWRITES_TITLE);
    await expect(warning).toContainText("Header");
    await expect(warning).toContainText("title: Summer sale → Winter sale");
    // The live site's label change is not touched by the draft: not listed.
    await expect(warning).not.toContainText("label");
  });

  test("stays quiet when the draft and the live site changed different values", async ({
    authedPage,
  }) => {
    test.slow();
    const { page, orgSlug } = authedPage;
    const url = await openDraftWith(page.context().request, orgSlug, {
      live: { ...header, label: "SS Rio" },
      draft: { ...header, collection: "667" },
    });
    await page.goto(url);
    await page
      .getByRole("button", { name: REVIEW_AND_PUBLISH, exact: true })
      .click({ timeout: SHELL_TIMEOUT_MS });

    await expect(
      page.getByRole("button", { name: /^Publish( \d+ changes?)?$/ }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(page.getByTestId("publish-overwrites")).toHaveCount(0);
  });
});
