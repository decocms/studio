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
  inspectStubRepo,
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

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    const pageJsonWrites: Array<{ url: string; body: unknown }> = [];
    page.on("request", (request) => {
      if (
        request.method() === "PATCH" &&
        request.url().includes("/decofile/")
      ) {
        pageJsonWrites.push({
          url: request.url(),
          body: request.postDataJSON(),
        });
      }
    });
    const owner = uniqueOwner();
    const repo = "site";
    const branch = "draft";

    const project = await createFastPreviewProject(api, orgSlug, {
      owner,
      repo,
      /** Closed port: the PR lookup must fail instantly, not dial a real host. */
      connectionUrl: "http://127.0.0.1:1/unused",
    });
    const committedMeta = `${JSON.stringify({
      manifest: {
        blocks: {
          apps: {
            "site/apps/site.ts": { $ref: "#/definitions/SiteApp" },
          },
          pages: {
            "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
          },
          sections: {
            "website/sections/Hero.tsx": { $ref: "#/definitions/Hero" },
          },
        },
      },
      schema: {
        definitions: {
          Page: { type: "object", properties: {} },
          Hero: { title: "Hero", type: "object", properties: {} },
          SiteApp: { title: "Site settings", type: "object", properties: {} },
        },
      },
    })}\n`;
    const siteBlock =
      '{"__resolveType":"site/apps/site.ts","siteName":"Test site"}\n';

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
        main: {
          files: {
            ".deco/blocks/Hero.json":
              '{"__resolveType":"website/sections/Hero.tsx","n":1}\n',
            ".deco/blocks/pages-Home.json":
              '{"name":"Home","path":"/","sections":[],"__resolveType":"website/pages/Page.tsx"}\n',
            ".deco/blocks/site.json": siteBlock,
            ".deco/meta.gen.json": committedMeta,
          },
        },
        [branch]: {
          files: {
            ".deco/blocks/Hero.json":
              '{"__resolveType":"website/sections/Hero.tsx","n":2}\n',
            ".deco/blocks/pages-Home.json":
              '{"name":"Home","path":"/","sections":[],"__resolveType":"website/pages/Page.tsx"}\n',
            ".deco/blocks/site.json": siteBlock,
            ".deco/meta.gen.json": committedMeta,
          },
        },
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

    /* A medium split is where route chrome, editor controls, and publishing
       used to compete for one row. Keep both panels open to exercise the real
       CMS constraint rather than the roomy main-only state. */
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${project.vmcpId}&main=preview&sidepanel=true`,
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
    await expect(primary).toBeInViewport({ ratio: 1 });

    const mainPanel = page.getByTestId("main-panel");
    const chatPanel = page.getByTestId("chat-panel");
    const mainBox = await mainPanel.boundingBox();
    const chatBox = await chatPanel.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(chatBox).not.toBeNull();
    if (!mainBox || !chatBox) {
      throw new Error("CMS split panels must be measurable");
    }
    await expect(
      page.locator('[data-workspace-layout="stacked"]'),
    ).toBeVisible();
    expect(mainBox.y + mainBox.height).toBeLessThanOrEqual(chatBox.y);
    expect(mainBox.width).toBeGreaterThan(500);

    /* The responsive shell gives the CMS enough horizontal room, then the
       inner editor stops forcing two cramped rails: Preview and Blocks are
       full-width mounted stages below the editor's own measured breakpoint. */
    // react-resizable-panels keeps its flex item mounted and applies our
    // visual stage classes to the item's direct child.
    const previewCanvas = page
      .getByTestId("preview-canvas")
      .locator(":scope > div");
    const blocksEditor = page
      .getByTestId("preview-blocks-editor")
      .locator(":scope > div");
    const blocksFocusTarget = page
      .getByTestId("blocks-panel")
      .locator('button:not([disabled]), input:not([disabled]), [tabindex="0"]')
      .first();
    const editBlocks = page.getByRole("button", {
      name: "Edit blocks",
      exact: true,
    });
    await expect(previewCanvas).toBeVisible();
    await expect(blocksEditor).toBeHidden();
    await expect(editBlocks).toBeVisible();
    expect((await previewCanvas.boundingBox())?.width ?? 0).toBeGreaterThan(
      500,
    );

    const previewFrame = previewCanvas.locator("iframe").first();
    await expect(previewFrame).toBeAttached();
    await previewFrame.evaluate((iframe) => {
      iframe.dataset.e2eMountedAcrossCompactStages = "true";
    });
    await editBlocks.click();
    const backToPreview = page.getByRole("button", {
      name: "Back to preview",
      exact: true,
    });
    await expect(blocksEditor).toBeVisible();
    await expect(previewCanvas).toBeHidden();
    await expect(backToPreview).toBeFocused();
    expect((await blocksEditor.boundingBox())?.width ?? 0).toBeGreaterThan(500);

    // Compact-only stage controls hand focus to a persistent contextual target
    // when widening; otherwise the removed button leaves focus on body.
    await page.setViewportSize({ width: 1600, height: 600 });
    await expect(backToPreview).toHaveCount(0);
    await expect(blocksFocusTarget).toBeFocused();
    // Restore the wide-screen canvas stage before checking the inverse
    // handoff. Focusing the Blocks target intentionally preserves Blocks as
    // the compact stage.
    await previewFrame.focus();
    await page.setViewportSize({ width: 900, height: 600 });
    await expect(editBlocks).toBeVisible();
    await editBlocks.focus();
    await page.setViewportSize({ width: 1600, height: 600 });
    await expect(editBlocks).toHaveCount(0);
    await expect(previewFrame).toBeFocused();
    await page.setViewportSize({ width: 900, height: 600 });
    await editBlocks.click();
    await expect(backToPreview).toBeFocused();

    await backToPreview.click();
    await expect(previewCanvas).toBeVisible();
    await expect(editBlocks).toBeFocused();
    await expect(previewFrame).toHaveAttribute(
      "data-e2e-mounted-across-compact-stages",
      "true",
    );

    const breadcrumb = mainPanel.getByRole("navigation", {
      name: "Breadcrumb",
      exact: true,
    });
    await expect(
      mainPanel.locator('[data-slot="main-topbar-left"]').getByRole("heading", {
        level: 1,
        name: "Site Editor",
        exact: true,
      }),
    ).toBeVisible();
    await expect(breadcrumb).not.toContainText("Site Editor");
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveCount(0);

    /* The CMS mode/page toolbar is a separate row. Its menu is bounded by the
       Main card instead of being clipped under the sidebar or right-hand Chat. */
    const editorToolbar = mainPanel.locator('[data-slot="main-toolbar"]');
    await expect(editorToolbar).toBeVisible();

    /* Device sizing is explicit route chrome, not a floating overlay on top of
       the page being edited. Pin both placement and the state contract: each
       choice names its logical viewport, exactly one is pressed, and changing
       it updates the iframe's layout width without remounting the frame. */
    const deviceControls = editorToolbar.getByRole("group", {
      name: "Preview size",
      exact: true,
    });
    await expect(deviceControls).toBeVisible();
    await expect(
      mainPanel
        .locator('[data-slot="main-toolbar-right"]')
        .getByRole("group", { name: "Preview size", exact: true }),
    ).toHaveCount(1);
    const desktopSize = deviceControls.getByRole("button", {
      name: "Desktop",
      exact: true,
    });
    const tabletSize = deviceControls.getByRole("button", {
      name: "Tablet (1024px)",
      exact: true,
    });
    const mobileSize = deviceControls.getByRole("button", {
      name: "Mobile (412px)",
      exact: true,
    });
    await expect(desktopSize).toHaveAttribute("aria-pressed", "true");
    await expect(deviceControls.locator('[aria-pressed="true"]')).toHaveCount(
      1,
    );

    await tabletSize.click();
    await expect(tabletSize).toHaveAttribute("aria-pressed", "true");
    await expect(desktopSize).toHaveAttribute("aria-pressed", "false");
    await expect(previewFrame.locator("..")).toHaveCSS("width", "1024px");

    await mobileSize.click();
    await expect(mobileSize).toHaveAttribute("aria-pressed", "true");
    await expect(tabletSize).toHaveAttribute("aria-pressed", "false");
    await expect(previewFrame.locator("..")).toHaveCSS("width", "412px");
    await expect(previewFrame).toHaveAttribute(
      "data-e2e-mounted-across-compact-stages",
      "true",
    );

    await desktopSize.click();
    await expect(desktopSize).toHaveAttribute("aria-pressed", "true");

    const choosePage = editorToolbar.getByRole("button", {
      name: "Choose page",
      exact: true,
    });
    await expect(choosePage).toBeInViewport({ ratio: 1 });
    await choosePage.click();
    const pageMenu = page.locator('[data-slot="cms-page-menu"]');
    await expect(pageMenu).toBeVisible();
    const pageMenuBox = await pageMenu.boundingBox();
    expect(pageMenuBox).not.toBeNull();
    if (!pageMenuBox) throw new Error("CMS page menu must be measurable");
    expect(pageMenuBox.x).toBeGreaterThanOrEqual(mainBox.x);
    expect(pageMenuBox.x + pageMenuBox.width).toBeLessThanOrEqual(
      mainBox.x + mainBox.width,
    );
    expect(pageMenuBox.y).toBeGreaterThanOrEqual(mainBox.y);
    expect(pageMenuBox.y + pageMenuBox.height).toBeLessThanOrEqual(
      mainBox.y + mainBox.height,
    );
    const pagePickerSearch = pageMenu.getByPlaceholder(
      "Search pages and components...",
    );
    await expect(pagePickerSearch).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      pageMenu.getByRole("button", { name: "Create new page", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const homePageRow = pageMenu.getByRole("button", { name: /^Home\s+\/$/ });
    await expect(homePageRow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(pageMenu).toBeHidden();
    await expect(choosePage).toBeFocused();
    await choosePage.click();
    await expect(pageMenu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(choosePage).toBeFocused();

    const openCreatePage = async () => {
      await choosePage.click();
      await expect(pageMenu).toBeVisible();
      await pageMenu
        .getByRole("button", { name: "Create new page", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create new page",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("textbox", { name: "Name", exact: true }),
      ).toBeFocused();
      return dialog;
    };
    const escapedCreateDialog = await openCreatePage();
    await page.keyboard.press("Escape");
    await expect(escapedCreateDialog).toHaveCount(0);
    await expect(choosePage).toBeFocused();
    const cancelledCreateDialog = await openCreatePage();
    await cancelledCreateDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(cancelledCreateDialog).toHaveCount(0);
    await expect(choosePage).toBeFocused();

    /* Compact Preview isolates raw JSON as a third mounted stage. Opening it
       must not strand focus on the View JSON control that just became
       invisible; closing returns to the Blocks stage control. */
    await editBlocks.click();
    await expect(blocksEditor).toBeVisible();
    const viewJson = blocksEditor.getByRole("button", {
      name: "View JSON",
      exact: true,
    });
    await viewJson.focus();
    await page.keyboard.press("Enter");
    const closeJson = page.getByRole("button", {
      name: "Close",
      exact: true,
    });
    await expect(closeJson).toBeVisible();
    await expect(closeJson).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(closeJson).toHaveCount(0);
    await expect(backToPreview).toBeFocused();

    const pageJsonPanel = page.locator('[data-slot="page-json-panel"]');
    const replacePageJson = async (marker: string) => {
      const nextJson = JSON.stringify({
        name: "Home",
        path: "/",
        sections: [],
        __resolveType: "website/pages/Page.tsx",
        e2eUnmountFlush: marker,
      });
      const input = pageJsonPanel
        .locator(".monaco-editor textarea.inputarea")
        .first();
      const focusLiveInput = async () => {
        // Monaco can replace its hidden textarea while reconciling a model.
        // A one-shot `focus()` may therefore focus the outgoing node just as
        // the locator starts resolving the replacement. Re-acquire and focus
        // until the live textarea owns focus; this still drives the real
        // editor and does not reach into app state.
        await expect
          .poll(
            async () => {
              await input.focus();
              return input.evaluate(
                (element) => document.activeElement === element,
              );
            },
            { timeout: 5_000 },
          )
          .toBe(true);
      };
      await expect(input).toBeVisible();
      await focusLiveInput();
      const selectAllShortcut = await page.evaluate(() =>
        navigator.platform.toLowerCase().includes("mac")
          ? "Meta+A"
          : "Control+A",
      );
      await input.press(selectAllShortcut);
      await input.press("Backspace");
      await expect(pageJsonPanel.locator(".view-lines")).toHaveText("");
      /* Monaco may replace its hidden textarea while reconciling an empty
         model. Re-establish focus on the live input before sending the edit. */
      await focusLiveInput();
      await page.keyboard.insertText(nextJson);
      await expect(pageJsonPanel.locator(".view-lines")).toContainText(marker);
      const renderedJson = (
        await pageJsonPanel.locator(".view-line").allTextContents()
      ).join("");
      expect(renderedJson).toBe(nextJson);
    };
    const expectPageJsonMarker = async (marker: string) => {
      await expect
        .poll(async () => {
          const inspection = await inspectStubRepo(api, owner, repo);
          const raw =
            inspection.branches[branch]?.files[".deco/blocks/pages-Home.json"];
          if (!raw) return null;
          return (JSON.parse(raw) as { e2eUnmountFlush?: string })
            .e2eUnmountFlush;
        })
        .toBe(marker);
    };

    /* A valid edit inside the debounce window belongs to the JSON panel's
       lifecycle, not only its Close button. Selecting a global component
       unmounts the page panel immediately; it must flush and leave compact
       Preview on a reachable Blocks stage. */
    await viewJson.click();
    await replacePageJson("global-component");
    await choosePage.click();
    await pageMenu.getByRole("button", { name: /^Hero(?:\s+Hero)?$/ }).click();
    await expect(pageJsonPanel).toHaveCount(0);
    await expect(blocksEditor).toBeVisible();
    await expect(backToPreview).toBeVisible();
    await expect
      .poll(() => JSON.stringify(pageJsonWrites))
      .toContain("global-component");
    await expectPageJsonMarker("global-component");

    // Return to the page, then leave Preview itself during another pending
    // edit. Route teardown must make the same persistence guarantee.
    await choosePage.click();
    await pageMenu.getByRole("button", { name: /^Home\s+\/$/ }).click();
    await viewJson.click();
    await replacePageJson("route-transition");
    await mainPanel
      .getByRole("button", { name: "Content", exact: true })
      .click();
    await expect(pageJsonPanel).toHaveCount(0);
    await expectPageJsonMarker("route-transition");
    await mainPanel
      .getByRole("button", { name: "Preview", exact: true })
      .click();
    await expect(choosePage).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await choosePage.focus();

    /* Wide workspaces keep Chat physically right. A user can still resize Main
       to its usable floor; crossing layout modes must not remount the editor
       or discard focus/state. The project level remains keyboard-reachable
       through the real overflow menu. */
    await page.setViewportSize({ width: 1600, height: 720 });
    await expect(
      page.locator('[data-workspace-layout="columns"]'),
    ).toBeVisible();
    await expect(choosePage).toBeFocused();
    await expect(blocksEditor).toBeVisible();
    await expect(previewCanvas).toBeVisible();

    // Direct wide close returns to the exact invoking control.
    await viewJson.focus();
    await page.keyboard.press("Enter");
    await expect(closeJson).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(closeJson).toHaveCount(0);
    await expect(viewJson).toBeFocused();

    // Restoration follows the layout at close time, not the layout snapshot
    // from open: wide → compact returns to a visible Blocks stage control.
    await page.keyboard.press("Enter");
    await expect(closeJson).toBeFocused();
    await page.setViewportSize({ width: 1200, height: 720 });
    await expect(closeJson).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(closeJson).toHaveCount(0);
    await expect(backToPreview).toBeFocused();

    // The inverse transition finds the still-connected View JSON trigger once
    // Blocks becomes visible alongside the canvas again.
    await viewJson.focus();
    await page.keyboard.press("Enter");
    await expect(closeJson).toBeFocused();
    await page.setViewportSize({ width: 1600, height: 720 });
    await expect(blocksEditor).toBeVisible();
    await expect(previewCanvas).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(closeJson).toHaveCount(0);
    await expect(viewJson).toBeFocused();
    await expect(blocksFocusTarget).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await blocksFocusTarget.focus();
    await expect(blocksFocusTarget).toBeFocused();

    // Crossing only Preview's measured breakpoint keeps the focused Blocks
    // subtree active instead of replacing it with the default Canvas stage.
    await page.setViewportSize({ width: 1200, height: 720 });
    await expect(
      page.locator('[data-workspace-layout="columns"]'),
    ).toBeVisible();
    await expect(blocksEditor).toBeVisible();
    await expect(previewCanvas).toBeHidden();
    await expect(blocksFocusTarget).toBeFocused();
    const mainColumn = page.getByTestId("workspace-main-panel");
    const chatColumn = page.getByTestId("workspace-side-panel");
    const initialColumnMainBox = await mainColumn.boundingBox();
    const initialColumnChatBox = await chatColumn.boundingBox();
    expect(initialColumnMainBox?.width ?? 0).toBeGreaterThanOrEqual(559);
    expect(initialColumnChatBox?.width ?? 0).toBeGreaterThanOrEqual(319);
    const workspaceSeparator = page.getByTestId("workspace-panel-separator");
    const separatorBox = await workspaceSeparator.boundingBox();
    const columnMainBox = await mainColumn.boundingBox();
    expect(separatorBox).not.toBeNull();
    expect(columnMainBox).not.toBeNull();
    if (!separatorBox || !columnMainBox) {
      throw new Error("Column workspace must be measurable");
    }
    const separatorY = separatorBox.y + separatorBox.height / 2;
    await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorY);
    await page.mouse.down();
    // Capture the pointer in the parent document before crossing Preview's
    // iframe; otherwise the framed canvas can consume the drag and leave the
    // workspace split unchanged.
    await page.mouse.move(separatorBox.x + separatorBox.width + 4, separatorY);
    await page.mouse.move(columnMainBox.x + 560, separatorY, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(async () => (await mainColumn.boundingBox())?.width ?? 0)
      .toBeLessThanOrEqual(580);
    await expect
      .poll(async () => (await mainColumn.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(559);
    await workspaceSeparator.focus();
    await page.keyboard.press("Enter");
    await expect(mainPanel).toBeVisible();
    expect((await mainColumn.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(
      559,
    );
    expect(new URL(page.url()).searchParams.get("mainpanel")).not.toBe("false");

    const persistedChatWidth = Number(
      await page.evaluate(() =>
        localStorage.getItem("studio:side-panel:width"),
      ),
    );
    expect(persistedChatWidth).toBeGreaterThan(35);
    expect(persistedChatWidth).toBeLessThan(50);
    await page.reload();
    await expect(page.locator('[data-workspace-layout="columns"]')).toBeVisible(
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect
      .poll(async () => (await mainColumn.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(559);
    await expect
      .poll(async () => (await mainColumn.boundingBox())?.width ?? 0)
      .toBeLessThanOrEqual(580);

    const projectParent = breadcrumb
      .locator('[data-slot="main-breadcrumb-scope"]')
      .getByRole("link");
    await projectParent.focus();
    await expect(projectParent).toBeFocused();
    const projectParentHref = await projectParent.getAttribute("href");
    expect(projectParentHref).not.toBeNull();
    expect(new URL(projectParentHref ?? "", page.url()).pathname).toBe(
      `/${orgSlug}/projects/${project.vmcpId}`,
    );

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

    /* Content uses the same actual-width rule as the outer workspace. At the
       Main column floor its rails become a mounted drill-in flow, preserving
       list input while Back/forward transitions restore useful focus. A
       direct editor such as Site skips the inapplicable Items stage. */
    await page.keyboard.press("Escape");
    const contentUrl = new URL(page.url());
    contentUrl.pathname = `/${orgSlug}/projects/${project.vmcpId}/site-editor/content`;
    await page.goto(contentUrl.toString());
    const collectionsStage = mainPanel.locator(
      '[data-content-stage="collections"]',
    );
    const itemsStage = mainPanel.locator('[data-content-stage="items"]');
    const detailStage = mainPanel.locator('[data-content-stage="detail"]');
    await expect(collectionsStage).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(itemsStage).toBeHidden();
    const pagesCollection = collectionsStage.getByRole("button", {
      name: /^Pages(?:\s+\d+)?$/,
    });
    await pagesCollection.click();
    await expect(itemsStage).toBeVisible();
    await expect(collectionsStage).toBeHidden();
    const pageSearch = itemsStage.getByRole("textbox", {
      name: "Search pages…",
      exact: true,
    });
    await expect(pageSearch).toBeFocused();
    await pageSearch.fill("Home");
    const backToCollections = itemsStage.getByRole("button", {
      name: "Back to collections",
      exact: true,
    });

    // The compact list Back control disappears at Content's own measured
    // breakpoint. Keep focus in the same task at its persistent search field.
    await backToCollections.focus();
    // The persisted split deliberately gives Chat a substantial right column;
    // use enough total width for Content itself (not merely the viewport) to
    // cross its 840px wide-mode threshold.
    await page.setViewportSize({ width: 2000, height: 720 });
    await expect(backToCollections).toHaveCount(0);
    await expect(pageSearch).toBeFocused();
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(backToCollections).toBeVisible();

    await backToCollections.click();
    await expect(collectionsStage).toBeVisible();
    await expect(pagesCollection).toBeFocused();
    await pagesCollection.click();
    await expect(pageSearch).toHaveValue("Home");
    await backToCollections.click();

    const siteCollection = collectionsStage.getByRole("button", {
      name: "Site",
      exact: true,
    });
    await siteCollection.click();
    await expect(detailStage).toBeVisible();
    await expect(itemsStage).toHaveCount(0);
    const directEditorBack = detailStage.getByRole("button", {
      name: "Back to collections",
      exact: true,
    });
    await expect(directEditorBack).toBeFocused();

    // This direct editor has neither an item rail nor an editable field.
    // Widening from its compact Back control therefore returns to the active
    // collection trigger rather than dropping focus on the document body.
    await page.setViewportSize({ width: 2000, height: 720 });
    await expect(directEditorBack).toHaveCount(0);
    await expect(siteCollection).toBeFocused();
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(directEditorBack).toBeVisible();

    await directEditorBack.click();
    await expect(siteCollection).toBeFocused();

    const previewUrl = new URL(page.url());
    previewUrl.pathname = `/${orgSlug}/projects/${project.vmcpId}/site-editor`;
    await page.goto(previewUrl.toString());

    /* Site Editor remains actionable on its one-surface mobile layout. The
       split-button keeps its accessible label while collapsing visible copy. */
    await page.setViewportSize({ width: 320, height: 720 });
    const mobileUrl = new URL(page.url());
    mobileUrl.searchParams.set("sidepanel", "false");
    mobileUrl.searchParams.set("mainpanel", "true");
    await page.goto(mobileUrl.toString());
    await expect(primary).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(primary).toBeInViewport({ ratio: 1 });
    await expect(
      mainPanel.locator('[data-slot="main-topbar-right"]').getByRole("button", {
        name: REVIEW_AND_PUBLISH,
        exact: true,
      }),
    ).toBeVisible();
  });

  test("serializes Page JSON flushes so the newest valid edit wins", async ({
    authedPage,
  }) => {
    test.slow();
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const owner = uniqueOwner();
    const repo = "page-json-save-order";
    const branch = "draft";
    const project = await createFastPreviewProject(api, orgSlug, {
      owner,
      repo,
      connectionUrl: "http://127.0.0.1:1/unused",
    });
    const meta = `${JSON.stringify({
      manifest: {
        blocks: {
          pages: {
            "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
          },
          sections: {
            "website/sections/Hero.tsx": { $ref: "#/definitions/Hero" },
          },
        },
      },
      schema: {
        definitions: {
          Page: { type: "object", properties: {} },
          Hero: { title: "Hero", type: "object", properties: {} },
        },
      },
    })}\n`;
    const homeBlock =
      '{"name":"Home","path":"/","sections":[],"__resolveType":"website/pages/Page.tsx"}\n';
    await seedStubRepo(api, {
      owner,
      repo,
      defaultBranch: "main",
      branches: {
        main: {
          files: {
            ".deco/blocks/pages-Home.json": homeBlock,
            ".deco/meta.gen.json": meta,
          },
        },
        [branch]: {
          files: {
            ".deco/blocks/pages-Home.json": homeBlock,
            ".deco/meta.gen.json": meta,
          },
        },
      },
    });
    const thread = await callSelfMcpTool<{
      item: { id: string; branch: string | null };
    }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: { virtual_mcp_id: project.vmcpId, branch },
    });
    expect(thread.item.branch).toBe(branch);

    const firstPatchReached = deferred();
    const releaseFirstPatch = deferred();
    const patchBodies: unknown[] = [];
    await page.route(
      new RegExp(
        `/api/${orgSlug}/decofile/${project.vmcpId}/${branch}(?:\\?|$)`,
      ),
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        patchBodies.push(route.request().postDataJSON());
        if (patchBodies.length === 1) {
          firstPatchReached.resolve();
          await releaseFirstPatch.promise;
        }
        await route.continue();
      },
    );

    try {
      await page.setViewportSize({ width: 900, height: 700 });
      await page.goto(
        `/${orgSlug}/projects/${project.vmcpId}/site-editor?thread=${thread.item.id}&sidepanel=false`,
      );
      const choosePage = page.getByRole("button", {
        name: "Choose page",
        exact: true,
      });
      await expect(choosePage).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await choosePage.click();
      await page
        .locator('[data-slot="cms-page-menu"]')
        .getByRole("button", { name: /^Home\s+\/$/ })
        .click();
      await page
        .getByRole("button", { name: "Edit blocks", exact: true })
        .click();
      await page
        .getByRole("button", { name: "View JSON", exact: true })
        .click();

      const jsonPanel = page.locator('[data-slot="page-json-panel"]');
      const input = jsonPanel
        .locator(".monaco-editor textarea.inputarea")
        .first();
      await expect(input).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      const selectAllShortcut = await page.evaluate(() =>
        navigator.platform.toLowerCase().includes("mac")
          ? "Meta+A"
          : "Control+A",
      );
      const saveShortcut = await page.evaluate(() =>
        navigator.platform.toLowerCase().includes("mac")
          ? "Meta+S"
          : "Control+S",
      );
      const replaceJson = async (marker: string) => {
        const next = JSON.stringify({
          name: "Home",
          path: "/",
          sections: [],
          __resolveType: "website/pages/Page.tsx",
          saveOrder: marker,
        });
        await input.focus();
        await input.press(selectAllShortcut);
        await input.press("Backspace");
        await page.keyboard.insertText(next);
        await expect(jsonPanel.locator(".view-lines")).toContainText(marker);
      };

      await replaceJson("older-in-flight");
      await input.press(saveShortcut);
      await firstPatchReached.promise;

      // Multiple edits behind the in-flight write still coalesce in the same
      // debounce slot. Closing synchronously flushes only the newest payload.
      await replaceJson("coalesced-intermediate");
      await replaceJson("newest-wins");
      await jsonPanel
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(jsonPanel).toHaveCount(0);
      await page.waitForTimeout(250);
      expect(patchBodies).toHaveLength(1);

      releaseFirstPatch.resolve();
      await expect.poll(() => patchBodies.length).toBe(2);
      await expect
        .poll(async () => {
          const inspection = await inspectStubRepo(api, owner, repo);
          const raw =
            inspection.branches[branch]?.files[".deco/blocks/pages-Home.json"];
          return raw
            ? (JSON.parse(raw) as { saveOrder?: string }).saveOrder
            : null;
        })
        .toBe("newest-wins");
      expect(JSON.stringify(patchBodies[0])).toContain("older-in-flight");
      expect(JSON.stringify(patchBodies[1])).toContain("newest-wins");
      expect(JSON.stringify(patchBodies)).not.toContain(
        "coalesced-intermediate",
      );
    } finally {
      releaseFirstPatch.resolve();
    }
  });
});
