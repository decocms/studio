/**
 * E2E: Fast Preview's publish surface — the header split button and the
 * popover it opens.
 *
 * Regression this spec exists for: picking "Submit for review" from the split
 * button's DROPDOWN opened the popover and then let it close itself a beat
 * later. Radix returns focus to the dropdown's trigger as the menu unmounts,
 * and the popover's dismissable layer counted that as focus landing outside
 * itself. Neither the pure state machine nor the change-summary modules can see
 * that — it only exists once a real menu and a real popover are on one page —
 * so it survived a fully unit-tested feature and shipped.
 *
 * Both entry points are asserted, because they differ in exactly the way that
 * mattered: the primary half opens the popover with no menu involved (it never
 * regressed), the dropdown half opens the same component through a closing
 * menu (it did).
 *
 * Setup is the sandbox-less Fast Preview wiring shared with `decofile-api` and
 * `fast-preview-git-sync`: all GitHub git traffic lands on the local Git Data
 * stub, so `/git/status` and `/git/diff` answer for real with no sandbox and no
 * credentials. The GitHub MCP connection is deliberately dead — the PR lookup
 * behind it must fail fast and leave the header on its no-open-PR state, which
 * is the state that offers "Submit for review" at all.
 *
 * Wire-contract strings (labels, `?virtualmcpid=` param) are inlined on
 * purpose — this suite owns its contract (see ban-e2e-app-imports).
 */

import type { Locator, Page } from "@playwright/test";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/**
 * Cold-Vite route compiles on a loaded box; the agent shell is a lazy route.
 * Deliberately under the whole test's budget (`test.slow()` = 90s) so a header
 * that never settles fails on THIS assertion rather than as a test timeout.
 */
const SHELL_TIMEOUT_MS = 60_000;

/**
 * How long the popover has to survive to prove it is not auto-closing. The
 * regression dismissed it ~450ms after it opened (one menu-close animation plus
 * the focus restore), so a fixed wait IS the assertion: proving that nothing
 * happens over an interval cannot be expressed as waiting for a state.
 */
const STAYS_OPEN_MS = 2_000;

/** UI copy — the header's split button (thread.cmsActions / headerActions). */
const REVIEW_AND_PUBLISH = "Review & Publish";
const MORE_ACTIONS = "More actions";
const SUBMIT_FOR_REVIEW = "Submit for review";

/** UI copy — the popover's own chrome (thread.publishPopover). */
const VERSION_NOTE = "Version note";
const REVIEW_NOTE = "Note for reviewers";
/** Publish mode counts the changes into its CTA; review mode never does. */
const PUBLISH_CTA = /^Publish( \d+ changes?)?$/;

/**
 * The popover's primary CTA in each mode. Matched as `role=button`, which is
 * what keeps `submitCta` from also matching the same-named `role=menuitem` in
 * the dropdown that opens it.
 */
function ctas(page: Page): { submit: Locator; publish: Locator } {
  return {
    submit: page.getByRole("button", { name: SUBMIT_FOR_REVIEW, exact: true }),
    publish: page.getByRole("button", { name: PUBLISH_CTA }),
  };
}

test.describe("fast preview publish surface", () => {
  test("both the primary half and the dropdown open a popover that stays open", async ({
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

    /**
     * `draft` sits one commit ahead of `main` with a changed block: that is
     * what puts the header in its publishable state (aheadOfBase > 0) and what
     * gives the popover a non-empty diff to summarize.
     */
    await seedStubRepo(api, {
      owner,
      repo,
      defaultBranch: "main",
      branches: {
        main: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
        [branch]: { files: { ".deco/blocks/Hero.json": '{"n":2}\n' } },
      },
    });

    // The header reads its branch off the thread row.
    const thread = await callSelfMcpTool<{
      item: { id: string; branch: string | null };
    }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: { virtual_mcp_id: project.vmcpId, branch },
    });
    /**
     * The tool only honours an input branch on a repo-backed vMCP. If that ever
     * stops holding, every assertion below degrades into "the header rendered
     * nothing", so it is pinned here where the failure stays legible.
     */
    expect(thread.item.branch).toBe(branch);

    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${project.vmcpId}`,
    );

    const { submit, publish } = ctas(page);
    const primary = page.getByRole("button", {
      name: REVIEW_AND_PUBLISH,
      exact: true,
    });

    /**
     * The header reaches this label only once `/git/status` has answered from
     * the stub and the PR lookup has failed — the no-open-PR, work-to-publish
     * state that "Submit for review" belongs to.
     */
    await expect(primary).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    // --- Entry point 1: the dropdown (the half that regressed) -------------
    await page.getByRole("button", { name: MORE_ACTIONS }).click();
    await page
      .getByRole("menuitem", { name: SUBMIT_FOR_REVIEW, exact: true })
      .click();

    await expect(submit).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(REVIEW_NOTE, { exact: true })).toBeVisible();

    // The regression: open now, gone a blink later.
    await page.waitForTimeout(STAYS_OPEN_MS);
    await expect(
      submit,
      "review popover dismissed itself after the dropdown returned focus to its trigger",
    ).toBeVisible();

    // Review mode never counts changes into its CTA — publish mode always does.
    await expect(publish).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(submit).toBeHidden();

    // --- Entry point 2: the primary half -----------------------------------
    await primary.click();

    await expect(publish).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(VERSION_NOTE, { exact: true })).toBeVisible();

    await page.waitForTimeout(STAYS_OPEN_MS);
    await expect(publish, "publish popover dismissed itself").toBeVisible();

    // Two genuinely different surfaces, not one component re-labelled by accident.
    await expect(submit).toHaveCount(0);
  });
});
