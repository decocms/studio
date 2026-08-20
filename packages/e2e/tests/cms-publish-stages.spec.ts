/**
 * E2E: the Fast Preview publish popover loads in two beats, and the first one
 * is already usable.
 *
 * The surface used to hold everything behind one skeleton until the file
 * BODIES had been fetched — full old/new contents for every changed file, one
 * blob request each. It now renders its real card list, count, gate and an
 * enabled button from the changed-file MANIFEST that rides free on
 * `/git/status`, and treats bodies as an enrichment that only fills in section
 * sub-lines and the expanded diff.
 *
 * Only a browser can hold this: the two beats are distinguishable solely by
 * what is on screen at each one, and the whole point is that the button is
 * live before a request that has not returned yet. `/git/diff` is stalled with
 * `page.route` so the manifest beat is a state the test can stand still in
 * rather than a frame it has to catch.
 *
 * `data-publish-state` is the anchor because the visible copy cannot tell the
 * beats apart — the CTA reads "Publish 1 change" in both.
 *
 * Setup mirrors `cms-publish-surface`: sandbox-less Fast Preview against the
 * local Git Data stub, with a deliberately dead GitHub MCP connection so the
 * header settles on its no-open-PR state. Wire-contract strings are inlined on
 * purpose — this suite owns its contract (see ban-e2e-app-imports).
 */

import type { Locator } from "@playwright/test";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/** Cold-Vite route compile on a loaded box; the agent shell is a lazy route. */
const SHELL_TIMEOUT_MS = 60_000;

/** UI copy — the header's split button and the popover's chrome. */
const REVIEW_AND_PUBLISH = "Review & Publish";
const VERSION_NOTE = "Version note";

/** The CTA carries its final count from the manifest beat onward. */
const PUBLISH_ONE = "Publish 1 change";

/**
 * The settled `y` of an element, once it stops moving.
 *
 * The popover opens with a zoom/slide animation, so a box read the instant the
 * manifest lands is mid-transform and sits a few px off its final position —
 * which would otherwise be indistinguishable from the layout shift this spec
 * exists to catch. Reading until two samples agree measures layout, not motion.
 */
async function settledY(locator: Locator): Promise<number> {
  let previous = (await locator.boundingBox())?.y ?? 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    await locator.page().waitForTimeout(50);
    const current = (await locator.boundingBox())?.y ?? 0;
    if (Math.abs(current - previous) < 0.5) return current;
    previous = current;
  }
  return previous;
}

test.describe("fast preview publish stages", () => {
  test("the card list, count and button are live while file bodies are still loading", async ({
    authedPage,
  }) => {
    // Signup + project wiring + a cold shell route compile.
    test.slow();

    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const owner = uniqueOwner();
    const repo = "site";
    const branch = "draft";

    const project = await createFastPreviewProject(api, orgSlug, {
      owner,
      repo,
      /** Closed port: the PR lookup must fail instantly, not dial a real host. */
      connectionUrl: "http://127.0.0.1:1/unused",
    });

    await seedStubRepo(api, {
      owner,
      repo,
      defaultBranch: "main",
      branches: {
        main: { files: { ".deco/blocks/Hero.json": '{"name":"Hero"}\n' } },
        [branch]: {
          files: { ".deco/blocks/Hero.json": '{"name":"Hero","n":2}\n' },
        },
      },
    });

    const thread = await callSelfMcpTool<{
      item: { id: string; branch: string | null };
    }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: { virtual_mcp_id: project.vmcpId, branch },
    });
    expect(thread.item.branch).toBe(branch);

    /**
     * Hold every body request open for the life of the test. The manifest beat
     * is then a resting state, and `releaseBodies` is the only thing that can
     * end it — so anything asserted before that call is provably not waiting on
     * file contents.
     */
    let releaseBodies: () => void = () => {};
    const bodiesReleased = new Promise<void>((resolve) => {
      releaseBodies = resolve;
    });
    let bodyRequests = 0;
    await page.route("**/git/diff", async (route) => {
      bodyRequests += 1;
      await bodiesReleased;
      await route.continue();
    });

    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${project.vmcpId}`,
    );

    const primary = page.getByRole("button", {
      name: REVIEW_AND_PUBLISH,
      exact: true,
    });
    await expect(primary).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await primary.click();

    const surface = page.locator("[data-publish-state]");
    const publishCta = page.getByRole("button", {
      name: PUBLISH_ONE,
      exact: true,
    });

    // --- Beat one: the manifest ------------------------------------------
    await expect(surface).toHaveAttribute("data-publish-state", "manifest", {
      timeout: 30_000,
    });
    expect(
      bodyRequests,
      "the manifest beat must be reached without a body response",
    ).toBeGreaterThan(0);

    // The real card, named — not a ghost. Scoped to the surface: the name is
    // generic enough to collide with the page behind the popover.
    await expect(surface.getByText("Hero", { exact: true })).toBeVisible();
    await expect(page.getByText(VERSION_NOTE, { exact: true })).toBeVisible();

    // The whole point: actionable before the bodies land.
    await expect(publishCta).toBeVisible();
    await expect(publishCta).toBeEnabled();

    const beforeY = await settledY(publishCta);

    // --- Beat two: the bodies --------------------------------------------
    releaseBodies();
    await expect(surface).toHaveAttribute("data-publish-state", "ready", {
      timeout: 30_000,
    });

    // Same button, same label, same place: bodies add detail, never geometry.
    await expect(publishCta).toBeEnabled();
    expect(
      Math.abs((await settledY(publishCta)) - beforeY),
      "the publish button moved when file bodies landed",
    ).toBeLessThanOrEqual(1);
  });
});
