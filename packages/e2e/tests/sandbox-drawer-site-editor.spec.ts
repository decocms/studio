/** E2E: the sandbox PreviewDrawer renders on the Site Editor and nowhere else. */
import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.describe("sandbox drawer is scoped to the Site Editor", () => {
  test.describe.configure({ timeout: 240_000 });

  test("Preview, Content, and Code inherit the drawer, while Settings does not", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    await page.setViewportSize({ width: 900, height: 720 });

    // Placeholder GitHub connection — the URL doesn't need to resolve; only
    // its id is needed so `agentHasClonableSource` flips on.
    const conn = await createHttpConnection(api, orgSlug, {
      title: "github-placeholder",
      url: "http://127.0.0.1:1/unused",
    });

    // Clonable agent: connections[] AND metadata.githubRepo both reference
    // the same connection id (both halves are required for
    // `getActiveGithubRepo` → non-null, which is what
    // `agentHasClonableSource` checks).
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "drawer site-editor e2e",
          description: "cloneable",
          status: "active",
          pinned: false,
          connections: [{ connection_id: conn.id }],
          metadata: {
            githubRepo: {
              url: "https://github.com/example/repo",
              owner: "example",
              name: "repo",
              connectionId: conn.id,
            },
          },
        },
      },
    );

    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: agent.item.id } },
    );

    // The drawer's setup tab has visible text "sandbox" and a Terminal icon
    // (see drawer/toolbar.tsx :: SetupTab). Asserting on its tab semantics is
    // the cheap proof that the drawer chrome is mounted under the route; we
    // deliberately don't try to start the sandbox.
    const sandboxToolbarTab = page
      .getByTestId("main-panel")
      .getByRole("tab", { name: /^sandbox$/i });

    /** Every nested editor body inherits the drawer from the structural
     * parent. Navigating each URL as a fresh document guards against a drawer
     * left mounted by the previous child masking a missing composition. */
    const siteEditorBase = `/${orgSlug}/agents/${agent.item.id}/site-editor`;
    for (const child of ["", "/content", "/code"] as const) {
      const path = `${siteEditorBase}${child}`;
      await page.goto(`${path}?thread=${thread.item.id}&sidepanel=true`);
      await page.waitForURL(
        (url) =>
          url.pathname === path &&
          url.searchParams.get("thread") === thread.item.id &&
          url.searchParams.get("sidepanel") === "true" &&
          url.searchParams.get("virtualmcpid") === null,
        { timeout: 60_000 },
      );
      await expect(
        page
          .getByTestId("main-panel")
          .locator('[data-slot="main-topbar-left"]')
          .getByRole("heading", {
            level: 1,
            name: "Site Editor",
            exact: true,
          }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(sandboxToolbarTab).toBeVisible({ timeout: 60_000 });
      const breadcrumb = page
        .getByTestId("main-panel")
        .getByRole("navigation", { name: "Breadcrumb", exact: true });
      await expect(breadcrumb).toHaveCount(1);
      let agentBreadcrumbLink = breadcrumb.getByRole("link", {
        name: "drawer site-editor e2e",
        exact: true,
      });
      let overflowOpen = false;
      if (!(await agentBreadcrumbLink.isVisible().catch(() => false))) {
        await breadcrumb
          .getByRole("button", {
            name: "Show parent pages",
            exact: true,
          })
          .click();
        agentBreadcrumbLink = page.getByRole("menuitem", {
          name: "drawer site-editor e2e",
          exact: true,
        });
        overflowOpen = true;
      }
      await expect(agentBreadcrumbLink).toBeVisible();
      const agentBreadcrumbHref =
        await agentBreadcrumbLink.getAttribute("href");
      expect(agentBreadcrumbHref).not.toBeNull();
      expect(new URL(agentBreadcrumbHref ?? "", page.url()).pathname).toBe(
        siteEditorBase.replace("/site-editor", ""),
      );
      if (overflowOpen) await page.keyboard.press("Escape");
      await expect(breadcrumb).not.toContainText("Site Editor");
      await expect(breadcrumb.locator('[aria-current="page"]')).toHaveCount(0);
      await expect(
        page.getByTestId("main-panel").locator('[data-slot="main-toolbar"]'),
      ).toBeVisible();

      const mainPanel = page.getByTestId("main-panel");
      if (child === "") {
        await mainPanel
          .getByRole("button", { name: "Expand terminal", exact: true })
          .click();
        const drawerResize = mainPanel.getByRole("separator", {
          name: "Resize terminal",
          exact: true,
        });
        await expect(drawerResize).toBeVisible();
        await drawerResize.focus();
        await page.keyboard.press("End");
        const drawerMax = await drawerResize.getAttribute("aria-valuemax");
        expect(drawerMax).not.toBeNull();
        await expect(drawerResize).toHaveAttribute(
          "aria-valuenow",
          drawerMax ?? "",
        );
        const editorBodyBox = await mainPanel
          .locator('[data-slot="main-content"]')
          .boundingBox();
        expect(editorBodyBox).not.toBeNull();
        expect(editorBodyBox?.height ?? 0).toBeGreaterThanOrEqual(150);
        await mainPanel
          .getByRole("button", { name: "Collapse terminal", exact: true })
          .click();
      }

      // A short landscape viewport gives each half of the stacked workspace
      // only a small vertical budget. The drawer contracts its whole range so
      // the routed Preview, Content, or Code surface remains the majority.
      await page.setViewportSize({ width: 1000, height: 360 });
      await expect(
        page.locator('[data-workspace-layout="stacked"]'),
      ).toBeVisible();
      await mainPanel
        .getByRole("button", { name: "Expand terminal", exact: true })
        .click();
      const compactResize = mainPanel.getByRole("separator", {
        name: "Resize terminal",
        exact: true,
      });
      await expect(compactResize).toBeVisible();
      const [minAttribute, maxAttribute] = await Promise.all([
        compactResize.getAttribute("aria-valuemin"),
        compactResize.getAttribute("aria-valuemax"),
      ]);
      const drawerMin = Number(minAttribute);
      const drawerMax = Number(maxAttribute);
      expect(Number.isFinite(drawerMin)).toBe(true);
      expect(Number.isFinite(drawerMax)).toBe(true);
      expect(drawerMin).toBeLessThanOrEqual(drawerMax);

      await compactResize.focus();
      await page.keyboard.press("End");
      await expect(compactResize).toHaveAttribute(
        "aria-valuenow",
        String(drawerMax),
      );
      const drawer = compactResize.locator("..");
      const [drawerBox, editorBodyBox, workspaceBox, drawerStyles] =
        await Promise.all([
          drawer.boundingBox(),
          mainPanel.locator('[data-slot="main-content"]').boundingBox(),
          mainPanel
            .locator('[data-slot="site-editor-workspace"]')
            .boundingBox(),
          drawer.evaluate((element) => {
            const style = getComputedStyle(element);
            return { minHeight: style.minHeight, maxHeight: style.maxHeight };
          }),
        ]);
      expect(drawerBox).not.toBeNull();
      expect(editorBodyBox).not.toBeNull();
      expect(workspaceBox).not.toBeNull();
      if (!drawerBox || !editorBodyBox || !workspaceBox) {
        throw new Error("The adaptive drawer geometry must be measurable");
      }
      expect(parseFloat(drawerStyles.minHeight)).toBe(drawerMin);
      expect(parseFloat(drawerStyles.maxHeight)).toBe(drawerMax);
      expect(Math.abs(drawerBox.height - drawerMax)).toBeLessThanOrEqual(1);
      expect(editorBodyBox.height).toBeGreaterThan(drawerBox.height);
      expect(editorBodyBox.height).toBeGreaterThanOrEqual(
        workspaceBox.height * 0.5,
      );
      await mainPanel
        .getByRole("button", { name: "Collapse terminal", exact: true })
        .click();
      await page.setViewportSize({ width: 900, height: 720 });

      const mainBox = await page.getByTestId("main-panel").boundingBox();
      const chatBox = await page.getByTestId("chat-panel").boundingBox();
      expect(mainBox).not.toBeNull();
      expect(chatBox).not.toBeNull();
      if (!mainBox || !chatBox) {
        throw new Error("Site Editor split panels must be measurable");
      }
      await expect(
        page.locator('[data-workspace-layout="stacked"]'),
      ).toBeVisible();
      expect(mainBox.y + mainBox.height).toBeLessThanOrEqual(chatBox.y);
    }

    /** Wait on the settings body, so the absence below is a painted panel. */
    await page.goto(
      `/${orgSlug}/agents/${agent.item.id}/settings?thread=${thread.item.id}`,
    );
    await expect(page.getByPlaceholder("Project name")).toBeVisible({
      timeout: 60_000,
    });
    await expect(sandboxToolbarTab).toHaveCount(0);

    /** The already-bookmarked query grammar remains input-only and settles on
     *  the same canonical Site Editor route. */
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=code`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname ===
          `/${orgSlug}/agents/${agent.item.id}/site-editor/code` &&
        url.searchParams.get("thread") === thread.item.id &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("main") === null,
      { timeout: 60_000 },
    );
    await expect(sandboxToolbarTab).toBeVisible({ timeout: 60_000 });
    await expect(sandboxToolbarTab).toHaveAttribute("aria-selected", "true");
  });

  test("restores keyboard focus after a confirmed script-tab close", async ({
    authedPage,
  }) => {
    const { page, user, orgSlug } = authedPage;
    const api = page.context().request;
    const branch = "drawer-focus-e2e";
    const conn = await createHttpConnection(api, orgSlug, {
      title: "drawer-focus-github-placeholder",
      url: "http://127.0.0.1:1/unused",
    });
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "drawer focus e2e",
          description: "keyboard focus after closing script tabs",
          status: "active",
          pinned: false,
          connections: [{ connection_id: conn.id }],
          metadata: {
            githubRepo: {
              url: "https://github.com/example/drawer-focus",
              owner: "example",
              name: "drawer-focus",
              connectionId: conn.id,
            },
          },
        },
      },
    );
    const thread = await callSelfMcpTool<{
      item: { id: string; branch: string | null };
    }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: { virtual_mcp_id: agent.item.id, branch },
    });
    expect(thread.item.branch).toBe(branch);

    // The events stream only opens for a recorded sandbox. Seed the same
    // persisted contract SANDBOX_START owns, then keep all browser behavior
    // under test behind HTTP route interception.
    const db = await connectDevDb();
    try {
      const sandboxMap = {
        [user.userId]: {
          [branch]: {
            "agent-sandbox": {
              sandboxHandle: "drawer-focus-e2e",
              previewUrl: null,
              createdAt: Date.now(),
            },
          },
        },
      };
      const seeded = await db.query(
        `UPDATE connections
            SET metadata = jsonb_set(
              COALESCE(metadata::jsonb, '{}'::jsonb),
              '{sandboxMap}', $1::jsonb, true
            )::text
          WHERE id = $2 AND created_by = $3`,
        [JSON.stringify(sandboxMap), agent.item.id, user.userId],
      );
      expect(seeded.rowCount).toBe(1);
    } finally {
      await db.end();
    }

    const releaseDevKill = deferred();
    const releaseBuildKill = deferred();
    const killRequests = new Map<string, number>();
    const execRequests = new Map<string, number>();
    await page.route(
      new RegExp(
        `/api/${orgSlug}/sandbox/${agent.item.id}/${branch}/events(?:\\?|$)`,
      ),
      async (route) => {
        const match = new URL(route.request().url()).pathname.match(
          /\/exec\/(dev|build)$/,
        );
        const name = match?.[1] ?? "";
        execRequests.set(name, (execRequests.get(name) ?? 0) + 1);
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: { "cache-control": "no-cache" },
          body: [
            "event: scripts",
            'data: {"scripts":["dev","build"]}',
            "",
            "event: tasks",
            'data: {"active":[]}',
            "",
            "",
          ].join("\n"),
        });
      },
    );
    await page.route(
      new RegExp(
        `/api/${orgSlug}/sandbox/${agent.item.id}/${branch}/exec/(dev|build)(?:\\?|$)`,
      ),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );
    await page.route(
      new RegExp(
        `/api/${orgSlug}/sandbox/${agent.item.id}/${branch}/exec/(dev|build)/kill(?:\\?|$)`,
      ),
      async (route) => {
        const match = new URL(route.request().url()).pathname.match(
          /\/exec\/(dev|build)\/kill$/,
        );
        const name = match?.[1] ?? "";
        killRequests.set(name, (killRequests.get(name) ?? 0) + 1);
        await (name === "dev"
          ? releaseDevKill.promise
          : releaseBuildKill.promise);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );

    try {
      await page.goto(
        `/${orgSlug}/agents/${agent.item.id}/site-editor?thread=${thread.item.id}&sidepanel=false`,
      );
      const mainPanel = page.getByTestId("main-panel");
      const terminalTabs = mainPanel.getByRole("tablist", {
        name: "Terminal tabs",
        exact: true,
      });
      const devTab = terminalTabs.getByRole("tab", {
        name: "dev",
        exact: true,
      });
      await expect(devTab).toBeVisible({ timeout: 60_000 });

      await mainPanel
        .getByRole("button", { name: "Run script", exact: true })
        .click();
      await page.getByRole("button", { name: /build$/ }).click();
      const buildTab = terminalTabs.getByRole("tab", {
        name: "build",
        exact: true,
      });
      await expect(buildTab).toBeVisible();
      await expect(buildTab).toHaveAttribute("aria-selected", "true");
      await buildTab.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(devTab).toBeFocused();
      await expect(devTab).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowRight");
      await expect(buildTab).toBeFocused();
      await expect(buildTab).toHaveAttribute("aria-selected", "true");
      const buildExecCountBeforeClose = execRequests.get("build") ?? 0;

      const closeDev = mainPanel.getByRole("button", {
        name: "Close dev",
        exact: true,
      });
      await closeDev.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => killRequests.get("dev") ?? 0).toBe(1);
      await expect(closeDev).toBeFocused();
      await expect(closeDev).toHaveAttribute("aria-disabled", "true");
      // The ref guard closes the same-tick gap before `disabled` commits; the
      // disabled control then blocks repeat keyboard activation while pending.
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      expect(killRequests.get("dev")).toBe(1);
      releaseDevKill.resolve();
      await expect(closeDev).toHaveCount(0);
      await expect(buildTab).toBeFocused();

      // With no duplicate close left in flight, a restarted same-name tab is a
      // new incarnation and cannot disappear due to an old response (ABA).
      await mainPanel
        .getByRole("button", { name: "Run script", exact: true })
        .click();
      await page.getByRole("button", { name: /dev$/ }).click();
      await expect(devTab).toBeVisible();
      await page.waitForTimeout(200);
      expect(killRequests.get("dev")).toBe(1);
      await buildTab.click();

      const closeBuild = mainPanel.getByRole("button", {
        name: "Close build",
        exact: true,
      });
      await closeBuild.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => killRequests.get("build") ?? 0).toBe(1);
      await expect(closeBuild).toBeFocused();
      const drawerRun = mainPanel.getByRole("button", {
        name: "Run",
        exact: true,
      });
      await expect(drawerRun).toBeDisabled();
      await expect(
        mainPanel.getByRole("button", { name: "Stopping…", exact: true }),
      ).toBeDisabled();
      await drawerRun.evaluate((button) => {
        button.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await page.waitForTimeout(100);
      expect(execRequests.get("build") ?? 0).toBe(buildExecCountBeforeClose);
      releaseBuildKill.resolve();
      await expect(closeBuild).toHaveCount(0);
      await expect(
        mainPanel.getByRole("tab", { name: /^sandbox$/i }),
      ).toBeFocused();
    } finally {
      releaseDevKill.resolve();
      releaseBuildKill.resolve();
    }
  });
});
