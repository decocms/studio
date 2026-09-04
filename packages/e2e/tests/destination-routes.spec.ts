/**
 * E2E: the destination routes, and the legacy URLs that translate into them.
 *
 * The route grammar under test: **path = which page, search = how that page is
 * laid out.** Home, Tasks, Reports and Library are org-level paths. An agent
 * workspace puts identity in `/agents/<agentId>`, and each agent-owned surface
 * is nested below it. Preview, Content, and Code are children of Site Editor.
 * `sidepanel`, `mainpanel` and `thread` stay in search because they describe
 * the workspace layout rather than its identity.
 *
 * This covers the routing half of the deleted `nav-v2.spec.ts`. There is no
 * flag left to toggle — every org gets these routes — so what is worth pinning
 * is the address itself: each destination owns its URL, every legacy shape
 * still resolves to it, and the panels open the way the destination declares.
 *
 * Wire-contract strings (paths, search keys) are inlined by hand on purpose —
 * this suite owns its contract and imports no app code (see
 * `plugins/ban-e2e-app-imports.js`).
 */

import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { connectDevDb } from "../fixtures/db";
import {
  callSelfMcpTool,
  createHttpConnection,
  findOrgId,
} from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/** Cold-Vite route compiles can take a minute+ on a loaded box, and this spec
 *  crosses the shell plus four lazy main-panel views. */
const SHELL_TIMEOUT_MS = 90_000;

/** The two panels of the desktop workspace, by their test ids. The chat card
 *  renders its contents only while the side panel is open, so the ABSENCE of
 *  `chat-panel` is what "the chat is collapsed" looks like from outside. */
const chatPanel = (page: Page) => page.getByTestId("chat-panel");
const mainPanel = (page: Page) => page.getByTestId("main-panel");
const mainTopbar = (page: Page) =>
  mainPanel(page).locator('[data-slot="main-topbar"]');
const mainTopbarRegion = (page: Page, region: "left" | "center" | "right") =>
  mainTopbar(page).locator(`[data-slot="main-topbar-${region}"]`);

/** Resolve a parent from the adaptive trail without assuming it fits inline. */
async function breadcrumbParent(
  page: Page,
  breadcrumb: Locator,
  name: string,
): Promise<{ link: Locator; overflowed: boolean }> {
  const direct = breadcrumb.getByRole("link", { name, exact: true });
  if (await direct.isVisible()) return { link: direct, overflowed: false };

  await breadcrumb
    .getByRole("button", { name: "Show parent pages", exact: true })
    .click();
  return {
    link: page.getByRole("menuitem", { name, exact: true }),
    overflowed: true,
  };
}

/** Exercise the narrowest supported shell in a non-English locale. The key
 *  and stored value are deliberately inlined: this black-box suite owns the
 *  browser contract and must not import application source. */
async function usePortugueseMobileViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.addInitScript(() => {
    try {
      const key = "studio:user:preferences";
      const current = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(
        key,
        JSON.stringify({ ...current, language: "pt-BR" }),
      );
    } catch {
      /* Sandboxed child frames may have no storage; the app frame does. */
    }
  });
}

/** Add a same-document browser-history entry and let the mounted router handle
 * it. Panel buttons intentionally replace layout state, so this helper creates
 * the Back/Forward condition without importing or reaching into app code. */
async function pushSearchHistory(
  page: Page,
  updates: Record<string, string | null>,
): Promise<void> {
  await page.evaluate((next) => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(next)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    window.history.pushState(window.history.state, "", url);
  }, updates);
}

/**
 * A project to scope by: a virtual MCP with one connection. The connection
 * points at a closed port because nothing here talks to it — the entity is a
 * database row, and that row is all the route grammar needs.
 */
async function createProject(
  request: APIRequestContext,
  orgSlug: string,
  title: string,
  options?: {
    clonable?: boolean;
    layoutTabs?: ReadonlyArray<{ id: string; title: string }>;
  },
): Promise<string> {
  const connection = await createHttpConnection(request, orgSlug, {
    title: `${title} placeholder`,
    url: "http://127.0.0.1:1/unused",
  });
  const metadata =
    options?.clonable || options?.layoutTabs?.length
      ? {
          ...(options.clonable
            ? {
                githubRepo: {
                  url: "https://github.com/example/repo",
                  owner: "example",
                  name: "repo",
                  connectionId: connection.id,
                },
              }
            : {}),
          ...(options.layoutTabs?.length
            ? {
                ui: {
                  layout: {
                    tabs: options.layoutTabs.map((tab) => ({
                      ...tab,
                      view: {
                        type: "ext-app" as const,
                        appId: connection.id,
                      },
                    })),
                  },
                },
              }
            : {}),
        }
      : undefined;
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title,
        status: "active",
        pinned: false,
        connections: [{ connection_id: connection.id }],
        ...(metadata ? { metadata } : {}),
      },
    },
  );
  return agent.item.id;
}

async function createThread(
  request: APIRequestContext,
  orgSlug: string,
  virtualMcpId: string,
  title?: string,
): Promise<string> {
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: virtualMcpId, ...(title ? { title } : {}) } },
  );
  return thread.item.id;
}

/** Give a thread a real persisted turn, so a cold route load must recognize it
 *  as an existing chat rather than an empty composer. Setup goes through the
 *  database because the black-box API intentionally has no "seed message"
 *  endpoint; the UI still reads the turn through the production HTTP tool. */
async function populateThread(
  orgId: string,
  threadId: string,
  text: string,
): Promise<void> {
  const db = await connectDevDb();
  try {
    const suffix = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.query(
      `UPDATE threads
          SET title = $1, message_storage_version = 2, updated_at = $2
        WHERE id = $3 AND organization_id = $4`,
      ["Existing route chat", now, threadId, orgId],
    );
    await db.query(
      `INSERT INTO thread_message_parts
         (id, seq, org_id, thread_id, run_id, message_id, role, kind,
          payload, created_at)
       VALUES
         ($1, 0, $2, $3, $4, $5, 'user', 'text', $6::jsonb, $7),
         ($8, 1, $2, $3, $4, $5, 'user', 'finish', '{}'::jsonb, $7)`,
      [
        `part_route_${suffix}:text`,
        orgId,
        threadId,
        `run_route_${suffix}`,
        `msg_route_${suffix}`,
        JSON.stringify({ type: "text", text }),
        now,
        `part_route_${suffix}:finish`,
      ],
    );
  } finally {
    await db.end();
  }
}

/** How many threads this org owns. Scoped to the per-test org, so the count
 *  stays correct under `fullyParallel`. */
async function countOrgThreads(orgId: string): Promise<number> {
  const db = await connectDevDb();
  try {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM threads WHERE organization_id = $1`,
      [orgId],
    );
    return Number(rows[0]?.count ?? "-1");
  } finally {
    await db.end();
  }
}

/** Exact thread identities and owners, scoped to this test's organization. */
async function listOrgThreads(
  orgId: string,
): Promise<Array<{ id: string; virtual_mcp_id: string }>> {
  const db = await connectDevDb();
  try {
    const { rows } = await db.query<{
      id: string;
      virtual_mcp_id: string;
    }>(
      `SELECT id, virtual_mcp_id
         FROM threads
        WHERE organization_id = $1
        ORDER BY id`,
      [orgId],
    );
    return rows;
  } finally {
    await db.end();
  }
}

test.describe("destination routes", () => {
  /** The waits below run to SHELL_TIMEOUT_MS, past Playwright's 30s per-test
   *  default — without this the test-level timeout fires first and reports a
   *  misleading "element not found". */
  test.describe.configure({ timeout: 240_000 });

  test("every destination owns its own URL, and reaching one mints no thread", async ({
    authedPage: { page, orgSlug },
  }) => {
    const orgId = await findOrgId(page.context().request, orgSlug);

    const destinations = [
      { path: `/${orgSlug}/home`, panel: mainPanel },
      { path: `/${orgSlug}/tasks`, panel: mainPanel },
      { path: `/${orgSlug}/library`, panel: mainPanel },
      { path: `/${orgSlug}/reports`, panel: mainPanel },
    ] as const;

    for (const { path, panel } of destinations) {
      await page.goto(path);
      await expect(panel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      /* The address is the assertion: a destination is a page, so nothing may
         bounce it onward to a thread or to another destination. */
      expect(new URL(page.url()).pathname).toBe(path);
    }

    /* Cold entry must not mint a conversation nobody asked for: four
       destinations visited, still not one thread in this org. */
    expect(await countOrgThreads(orgId)).toBe(0);
  });

  test("route-owned titles and actions occupy their topbar regions", async ({
    authedPage: { page, orgSlug },
  }) => {
    const agentId = await createProject(
      page.context().request,
      orgSlug,
      "route topbar e2e",
    );
    await callSelfMcpTool(
      page.context().request,
      orgSlug,
      "AUTOMATION_CREATE",
      {
        name: "Topbar portal automation",
        virtual_mcp_id: agentId,
        messages: [],
        models: { tier: "smart" },
        temperature: 0.5,
        active: true,
      },
    );
    const routes = [
      { path: `/${orgSlug}/home`, title: "Home" },
      { path: `/${orgSlug}/tasks`, title: "Tasks" },
      { path: `/${orgSlug}/reports`, title: "Reports" },
      { path: `/${orgSlug}/library`, title: "Library" },
      { path: `/${orgSlug}/discover`, title: "Discover" },
      {
        path: `/${orgSlug}/agents/${agentId}`,
        title: "route topbar e2e",
        projectScoped: true,
      },
      {
        path: `/${orgSlug}/agents/${agentId}/site-editor`,
        title: "Site Editor",
        projectScoped: true,
      },
      {
        path: `/${orgSlug}/agents/${agentId}/settings`,
        title: "Settings",
        projectScoped: true,
      },
      {
        path: `/${orgSlug}/agents/${agentId}/automations`,
        title: "Automations",
        projectScoped: true,
      },
    ] as const;

    for (const route of routes) {
      await page.goto(route.path);
      await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      expect(new URL(page.url()).pathname).toBe(route.path);
      await expect(mainTopbar(page)).toHaveCount(1);
      await expect(
        mainTopbarRegion(page, "left").getByRole("heading", {
          level: 1,
          name: route.title,
          exact: true,
        }),
      ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      const breadcrumb = mainTopbarRegion(page, "left").getByRole(
        "navigation",
        { name: "Breadcrumb", exact: true },
      );
      await expect(breadcrumb).toHaveCount(1);
      /* The final route is the adjacent page title, not a repeated last crumb. */
      await expect(breadcrumb.locator('[aria-current="page"]')).toHaveCount(0);
      await expect(breadcrumb).not.toContainText(route.title);
      const scopeLink = breadcrumb.getByRole("link").first();
      await expect(scopeLink).toHaveText("");
      await expect(scopeLink).toHaveAttribute("aria-label", /\S/);
      await expect(scopeLink).toHaveAttribute(
        "href",
        new RegExp(`/${orgSlug}/home$`),
      );
      if ("projectScoped" in route && route.projectScoped) {
        if (route.path.endsWith(`/agents/${agentId}`)) {
          await expect(breadcrumb.getByRole("link")).toHaveCount(1);
        } else {
          const projectParent = await breadcrumbParent(
            page,
            breadcrumb,
            "route topbar e2e",
          );
          await expect(projectParent.link).toBeVisible();
          const href = await projectParent.link.getAttribute("href");
          expect(new URL(href ?? "", page.url()).pathname).toBe(
            `/${orgSlug}/agents/${agentId}`,
          );
          if (projectParent.overflowed) await page.keyboard.press("Escape");
        }
      }
    }

    /** The list body owns this action, but its portal must place the rendered
     * controls in the route's center and right-hand topbar regions. */
    await expect(
      mainTopbarRegion(page, "center").getByPlaceholder(
        "Search automations...",
      ),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      mainTopbarRegion(page, "right").getByRole("button", {
        name: "New automation",
        exact: true,
      }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    await page.goto(`/${orgSlug}/library`);
    const desktopLibrarySearch = mainTopbarRegion(
      page,
      "center",
    ).getByPlaceholder("Search all files…");
    await expect(desktopLibrarySearch).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await desktopLibrarySearch.focus();
    await page.setViewportSize({ width: 767, height: 720 });
    const mobileLibrarySearch = mainPanel(page)
      .locator('[data-slot="main-subheader"]')
      .getByPlaceholder("Search all files…");
    await expect(mobileLibrarySearch).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(desktopLibrarySearch).toBeFocused();
    const folderBreadcrumb = page.getByRole("navigation", {
      name: "Folder location",
      exact: true,
    });
    const folderHome = folderBreadcrumb.locator(
      '[data-slot="breadcrumb-page"]',
    );
    await expect(folderHome).toHaveText("");
    await expect(folderHome).toHaveAttribute("aria-label", "Home");
    const libraryActions = mainTopbarRegion(page, "right");
    const libraryControls = ["Refresh", "New folder", "Upload file"].map(
      (name) =>
        libraryActions.getByRole("button", {
          name,
          exact: true,
        }),
    );
    for (const control of libraryControls) {
      await expect(control).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    }

    /* At medium desktop widths the chat/sidebar chrome is active but the
       right grid column is narrow. Labels collapse to icons so no focusable
       Library action can be clipped by the topbar's overflow boundary. */
    await page.setViewportSize({ width: 900, height: 720 });
    for (const control of libraryControls) {
      await expect(control).toBeVisible();
      await expect(control).toBeInViewport({ ratio: 1 });
    }

    await page.goto(`/${orgSlug}/library?path=public`);
    const readOnlyActions = mainTopbarRegion(page, "right");
    const folderHomeLink = folderBreadcrumb.getByRole("button", {
      name: "Home",
      exact: true,
    });
    await expect(folderHomeLink).toHaveText("");
    await expect(
      readOnlyActions.getByRole("button", { name: "Refresh", exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      readOnlyActions.getByText("Read-only", { exact: true }),
    ).toBeVisible();
    await expect(
      readOnlyActions.getByRole("button", { name: "New folder", exact: true }),
    ).toHaveCount(0);
    await expect(
      readOnlyActions.getByRole("button", { name: "Upload file", exact: true }),
    ).toHaveCount(0);
  });

  test("every Settings sidebar destination owns a semantic breadcrumb", async ({
    authedPage: { page, orgSlug },
  }) => {
    const destinations = [
      ["general", "General"],
      ["profile", "Profile & Preferences"],
      ["ai-providers", "AI Providers"],
      ["connect", "Connect"],
      ["task-board", "Board"],
      ["connections", "Connections"],
      ["agents", "Projects"],
      ["automations", "Automations"],
      ["skills", "Skills"],
      ["monitor", "Monitor"],
      ["members", "Members"],
      ["secrets", "Secrets"],
      ["buckets", "Buckets"],
      ["store", "Store"],
      ["sso", "Security"],
    ] as const;

    for (const [segment, title] of destinations) {
      const path = `/${orgSlug}/settings/${segment}`;
      await page.goto(path);
      const breadcrumb = page.getByRole("navigation", {
        name: "Breadcrumb",
        exact: true,
      });
      await expect(breadcrumb).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
      await expect(
        page.locator('[data-slot="main-topbar-left"]').getByRole("heading", {
          level: 1,
          name: title,
          exact: true,
        }),
      ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await expect(breadcrumb.locator('[aria-current="page"]')).toHaveCount(0);
      await expect(breadcrumb).not.toContainText(title);
      await expect(breadcrumb.getByRole("link").first()).toHaveAttribute(
        "href",
        new RegExp(`/${orgSlug}/home$`),
      );
      await expect(
        breadcrumb.getByRole("link", { name: "Settings", exact: true }),
      ).toHaveAttribute("href", new RegExp(`/${orgSlug}/settings/general$`));
      expect(new URL(page.url()).pathname).toBe(path);
    }
  });

  test("Settings detail breadcrumbs use route titles while data is unavailable", async ({
    authedPage: { page, orgSlug },
  }) => {
    const cases = [
      {
        path: `/${orgSlug}/settings/connections/unavailable-provider`,
        title: "unavailable-provider",
      },
      {
        path: `/${orgSlug}/settings/connections/unavailable-provider/unknown/draft%20item`,
        title: "draft item",
      },
    ];

    for (const route of cases) {
      await page.goto(route.path);
      const topbarLeft = page.locator('[data-slot="main-topbar-left"]');
      await expect(
        topbarLeft.getByRole("heading", {
          level: 1,
          name: route.title,
          exact: true,
        }),
      ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

      const breadcrumb = topbarLeft.getByRole("navigation", {
        name: "Breadcrumb",
        exact: true,
      });
      await expect(breadcrumb).not.toContainText(route.title);
      await expect(breadcrumb.locator('[aria-current="page"]')).toHaveCount(0);
      const connectionsParent = await breadcrumbParent(
        page,
        breadcrumb,
        "Connections",
      );
      await expect(connectionsParent.link).toHaveAttribute(
        "href",
        new RegExp(`/${orgSlug}/settings/connections$`),
      );
      if (connectionsParent.overflowed) await page.keyboard.press("Escape");
    }
  });

  test("a tool detail contributes its connection parent without repeating the current page", async ({
    authedPage: { page, orgSlug },
  }) => {
    const connectionTitle = `Breadcrumb connection ${crypto.randomUUID()}`;
    await createHttpConnection(page.context().request, orgSlug, {
      title: connectionTitle,
      url: `http://127.0.0.1:1/breadcrumb-${crypto.randomUUID()}`,
    });

    await page.goto(`/${orgSlug}/settings/connections?tab=connected`);
    const connectionCard = page.getByRole("button").filter({
      has: page.getByRole("heading", {
        level: 3,
        name: connectionTitle,
        exact: true,
      }),
    });
    await expect(connectionCard).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await connectionCard.click();
    await page.waitForURL(
      (url) => url.pathname.startsWith(`/${orgSlug}/settings/connections/`),
      { timeout: SHELL_TIMEOUT_MS },
    );
    const connectionPath = new URL(page.url()).pathname;

    const toolTitle = "Run 100% safely";
    await page.goto(`${connectionPath}/tools/${encodeURIComponent(toolTitle)}`);

    const topbarLeft = page.locator('[data-slot="main-topbar-left"]');
    const breadcrumb = topbarLeft.getByRole("navigation", {
      name: "Breadcrumb",
      exact: true,
    });
    await expect(
      topbarLeft.getByRole("heading", {
        level: 1,
        name: toolTitle,
        exact: true,
      }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(topbarLeft.locator("h1")).toHaveCount(1);
    await expect(breadcrumb).not.toContainText(toolTitle);
    await expect(
      breadcrumb.getByRole("link", {
        name: connectionTitle,
        exact: true,
      }),
    ).toHaveAttribute("href", /\/settings\/connections\/[^?]+\?tab=tools$/);
    await expect(
      page.getByRole("navigation", {
        name: "Resource breadcrumb",
        exact: true,
      }),
    ).toHaveCount(0);

    await breadcrumb
      .getByRole("button", { name: "Show parent pages", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Connections", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const appSlug = connectionPath.split("/").at(-1);
    if (!appSlug) throw new Error("Connection route has no app slug");
    let releaseConnectionList!: () => void;
    let heldConnectionList = false;
    const connectionListGate = new Promise<void>((resolve) => {
      releaseConnectionList = resolve;
    });
    const mcpPattern = "**/api/*/tools/COLLECTION_CONNECTIONS_LIST";
    await page.addInitScript(() => {
      localStorage.removeItem("studio:rq-cache");
    });
    await page.route(mcpPattern, async (route) => {
      const body = route.request().postData() ?? "";
      let requestedSlug: unknown;
      try {
        const payload: unknown = JSON.parse(body);
        requestedSlug =
          typeof payload === "object" && payload && "slug" in payload
            ? payload.slug
            : undefined;
      } catch {
        requestedSlug = undefined;
      }
      if (!heldConnectionList && requestedSlug === appSlug) {
        heldConnectionList = true;
        await connectionListGate;
      }
      await route.continue();
    });

    try {
      const toolUrl = `${connectionPath}/tools/${encodeURIComponent(toolTitle)}`;
      await page.goto(toolUrl);
      await expect
        .poll(() => heldConnectionList, { timeout: SHELL_TIMEOUT_MS })
        .toBe(true);

      const staticConnections = breadcrumb.getByRole("link", {
        name: "Connections",
        exact: true,
      });
      await expect(staticConnections).toBeVisible();
      await staticConnections.focus();
      releaseConnectionList();

      const loadedConnection = breadcrumb.getByRole("link", {
        name: connectionTitle,
        exact: true,
      });
      await expect(loadedConnection).toBeFocused({
        timeout: SHELL_TIMEOUT_MS,
      });
      await loadedConnection.press("Enter");
      await page.waitForURL((url) => url.pathname === connectionPath, {
        timeout: SHELL_TIMEOUT_MS,
      });
      await expect(
        page.locator('[data-slot="main-topbar-left"]').getByRole("heading", {
          level: 1,
          name: connectionTitle,
          exact: true,
        }),
      ).toBeFocused({ timeout: SHELL_TIMEOUT_MS });
    } finally {
      releaseConnectionList();
      await page.unroute(mcpPattern);
    }
  });

  test("the org landing resolves into a destination", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.goto(`/${orgSlug}#workspace`);
    /* The resolver forwards a scope the URL names and otherwise lands on Home.
       Nothing names one here, so Home it is. */
    await page.waitForURL(
      (url) => url.pathname === `/${orgSlug}/home` && url.hash === "#workspace",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  test("the bare org legacy Library link preserves its browse path", async ({
    authedPage: { page, orgSlug },
  }) => {
    const path = "home/docs/Q1 plan.md";
    const search = new URLSearchParams({
      main: "files",
      path,
      sidepanel: "true",
    });

    await page.goto(`/${orgSlug}?${search}#library-file`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/library` &&
        url.searchParams.get("path") === path &&
        url.searchParams.get("sidepanel") === "true" &&
        url.searchParams.get("main") === null &&
        url.hash === "#library-file",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  test("the bare org legacy Tasks link preserves its card and filters", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "bare org legacy task route e2e" },
    );
    const expected = {
      view: "list",
      q: "launch plan",
      assignee: "user-1",
      priority: "high",
      due: "week",
      tags: "red,blue",
      repo: "example/site",
    } as const;
    const search = new URLSearchParams({
      main: "board",
      task: item.id,
      ...expected,
    });

    await page.goto(`/${orgSlug}?${search}#task-card`);
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith(`/${orgSlug}/tasks/`) &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("task") === null &&
        Object.entries(expected).every(
          ([key, value]) => url.searchParams.get(key) === value,
        ) &&
        url.hash === "#task-card",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(page.getByTestId("task-detail")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
  });

  test("the bare org legacy Chat link keeps its named agent and layout", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const agentId = await createProject(
      request,
      orgSlug,
      "bare org legacy chat e2e",
    );
    const threadId = await createThread(request, orgSlug, agentId);
    const search = new URLSearchParams({
      virtualmcpid: agentId,
      main: "chat",
      thread: threadId,
      sidepanel: "true",
      mainpanel: "false",
    });

    await page.goto(`/${orgSlug}?${search}#composer`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}` &&
        url.searchParams.get("thread") === threadId &&
        url.searchParams.get("sidepanel") === "true" &&
        url.searchParams.get("mainpanel") === "false" &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null &&
        url.hash === "#composer",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toBeHidden({ timeout: SHELL_TIMEOUT_MS });
  });

  test("the bare org legacy closed-main sentinel reaches Home cleanly", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.goto(`/${orgSlug}?main=0&sidepanel=chat#closed-main`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/home` &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("mainpanel") === "false" &&
        url.searchParams.get("sidepanel") === "true" &&
        url.hash === "#closed-main",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toBeHidden({ timeout: SHELL_TIMEOUT_MS });
  });

  test("a legacy thread URL translates to the first-class shape", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "legacy shape e2e");
    const threadId = await createThread(request, orgSlug, projectId);

    /* Agent identity moves into the canonical path and the thread id moves to
       layout search. Both legacy routing keys disappear. */
    await page.goto(`/${orgSlug}/${threadId}?virtualmcpid=${projectId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* An unscoped legacy URL first reaches Home, then the loaded thread row
       supplies the missing owner. Wait for that settled URL: mounting a
       project thread under the Super Agent, even briefly as final state,
       would put chat/runtime providers in the wrong tenant scope. */
    await page.goto(`/${orgSlug}/${threadId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  test("an unscoped legacy Super Agent view keeps its named destination", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const superAgentId = `decopilot_${orgId}`;
    const threadId = await createThread(request, orgSlug, superAgentId);

    /* The oldest Super Agent links predate `?virtualmcpid=`. Their named main
       view still belongs to the Super Agent; only an entirely unscoped base
       thread lands on organization Home. */
    await page.goto(`/${orgSlug}/home`);
    await page.goto(
      `/${orgSlug}/${threadId}?main=settings&sidepanel=true#settings`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${superAgentId}/settings` &&
        url.searchParams.get("thread") === threadId &&
        url.searchParams.get("sidepanel") === "true" &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null &&
        url.hash === "#settings",
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* The compatibility rewrite replaces the legacy entry instead of leaving
       it in Back history, so Back returns to the page before the old URL. */
    await page.goBack();
    await page.waitForURL((url) => url.pathname === `/${orgSlug}/home`, {
      timeout: SHELL_TIMEOUT_MS,
    });
  });

  test("a repo-backed legacy settings URL creates only its named thread", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const agentId = await createProject(
      request,
      orgSlug,
      "legacy repo settings e2e",
      { clonable: true },
    );
    const intendedThreadId = crypto.randomUUID();
    expect(await listOrgThreads(orgId)).toEqual([]);

    /* This is the last view-first URL shape: the path names no agent or view,
       while all three identities arrive in search. The intended thread does
       not exist yet, so the real shell must create that exact id. A repo-backed
       agent would mint a fallback thread if the compatibility redirects lost
       `thread` at either hop. */
    await page.goto(
      `/${orgSlug}/agents?main=settings&virtualmcpid=${agentId}&thread=${intendedThreadId}`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}/settings` &&
        url.searchParams.get("thread") === intendedThreadId &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(page.getByPlaceholder("Project name")).toHaveValue(
      "legacy repo settings e2e",
      { timeout: SHELL_TIMEOUT_MS },
    );

    expect(await listOrgThreads(orgId)).toEqual([
      { id: intendedThreadId, virtual_mcp_id: agentId },
    ]);
  });

  /** A legacy org-owned view can be the translator's first hop, but the thread
   * row is authoritative about where the chat may mount. Once ownership loads,
   * both old shapes settle on the owning agent rather than leaving a project
   * thread attached to Tasks or Library. */
  for (const { main, destination } of [
    { main: "board", destination: "tasks" },
    { main: "files", destination: "library" },
  ] as const) {
    test(`a legacy main=${main} thread settles on its owning agent after /${destination}`, async ({
      authedPage: { page, orgSlug },
    }) => {
      const request = page.context().request;
      const projectId = await createProject(
        request,
        orgSlug,
        `legacy ${main} e2e`,
      );
      const threadId = await createThread(request, orgSlug, projectId);

      await page.goto(
        `/${orgSlug}/${threadId}?virtualmcpid=${projectId}&main=${main}`,
      );
      await page.waitForURL(
        (url) =>
          url.pathname === `/${orgSlug}/agents/${projectId}` &&
          url.searchParams.get("thread") === threadId,
        { timeout: SHELL_TIMEOUT_MS },
      );
      const landed = new URL(page.url());
      expect(landed.searchParams.get("thread")).toBe(threadId);
      expect(landed.searchParams.get("virtualmcpid")).toBeNull();
      expect(landed.searchParams.get("main")).toBeNull();
    });
  }

  /**
   * A card is a thing you open, so it has a path of its own. The key it wears
   * is the address the app writes: an id or a loose spelling settles onto it,
   * the short link is an alias for it, and a legacy `?task=` retires into it.
   */
  test("a card owns its path, and every older shape lands on it", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "card url e2e" },
    );

    /* The raw id resolves, then the board rewrites it to the human key — so
       the address bar always shows the form worth pasting somewhere. */
    await page.goto(`/${orgSlug}/tasks/${item.id}`);
    await expect(page.getByTestId("task-detail")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    const cardPath = new URL(page.url()).pathname;
    expect(cardPath).not.toBe(`/${orgSlug}/tasks/${item.id}`);
    expect(cardPath.startsWith(`/${orgSlug}/tasks/`)).toBe(true);
    const key = cardPath.slice(`/${orgSlug}/tasks/`.length);

    /* A lowercase, unpadded spelling names the same card and canonicalizes. */
    await page.goto(`/${orgSlug}/tasks/${key.toLowerCase()}`);
    await page.waitForURL((url) => url.pathname === cardPath, {
      timeout: SHELL_TIMEOUT_MS,
    });

    /* The short link in every digest email already delivered: a thin alias. */
    await page.goto(`/${orgSlug}/t/${key}`);
    await page.waitForURL((url) => url.pathname === cardPath, {
      timeout: SHELL_TIMEOUT_MS,
    });

    /* `?task=<id>` was the card's address before it had a path. It is accepted
       as a legacy INPUT and rewritten, never written. */
    await page.goto(`/${orgSlug}/tasks?task=${item.id}#details`);
    await page.waitForURL(
      (url) =>
        url.pathname === cardPath &&
        url.searchParams.get("task") === null &&
        url.hash === "#details",
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* An unknown key lands on the board, not an error page — the card was
       probably deleted, and the board is where you would look next. */
    await page.goto(`/${orgSlug}/t/NOPE-99?q=kept#tasks`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/tasks` &&
        url.searchParams.get("q") === "kept" &&
        url.hash === "#tasks",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  /**
   * Agent identity and its surface are separate path segments. Whether the
   * panel is OPEN remains layout search, so closing it keeps the same place.
   * The old search-carried identity and `?main=` remain accepted inputs only.
   */
  test("an agent surface is canonical, and legacy search settles on it", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "panel path e2e");

    await page.goto(`/${orgSlug}/agents/${projectId}/settings?sidepanel=true`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(page.getByTestId("workspace-panel-separator")).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("virtualmcpid")).toBeNull();

    /* Main is the primary reading surface and Chat is its right-hand
       companion. Pin both DOM and visual order: keyboard traversal should
       agree with what the user sees, not merely look reversed with CSS. */
    const workspaceColumns = page.locator(
      '[data-testid="workspace-main-panel"], [data-testid="workspace-panel-separator"], [data-testid="workspace-side-panel"]',
    );
    expect(
      await workspaceColumns.evaluateAll((columns) =>
        columns.map((column) => column.getAttribute("data-testid")),
      ),
    ).toEqual([
      "workspace-main-panel",
      "workspace-panel-separator",
      "workspace-side-panel",
    ]);
    const mainColumnBox = await page
      .getByTestId("workspace-main-panel")
      .boundingBox();
    const separatorBox = await page
      .getByTestId("workspace-panel-separator")
      .boundingBox();
    const chatColumnBox = await page
      .getByTestId("workspace-side-panel")
      .boundingBox();
    expect(mainColumnBox).not.toBeNull();
    expect(separatorBox).not.toBeNull();
    expect(chatColumnBox).not.toBeNull();
    if (!mainColumnBox || !separatorBox || !chatColumnBox) {
      throw new Error("Both workspace panels and their separator must exist");
    }
    expect(mainColumnBox.x).toBeLessThan(separatorBox.x);
    expect(separatorBox.x).toBeLessThan(chatColumnBox.x);

    /* Panel controls name their semantic target rather than the edge they
       happen to occupy. They remain compact icon buttons in the crowded CMS
       toolbar while exposing state and ownership to assistive technology. */
    const hideMain = mainTopbarRegion(page, "left").getByRole("button", {
      name: "Hide panel",
      exact: true,
    });
    const hideChat = mainTopbarRegion(page, "right").getByRole("button", {
      name: "Hide chat",
      exact: true,
    });
    await expect(hideMain).toHaveAttribute(
      "aria-controls",
      "workspace-main-panel",
    );
    await expect(hideMain).toHaveAttribute("aria-expanded", "true");
    await expect(hideMain).toHaveText("");
    await expect(hideChat).toHaveAttribute(
      "aria-controls",
      "workspace-side-panel",
    );
    await expect(hideChat).toHaveAttribute("aria-expanded", "true");
    await expect(hideChat).toHaveText("");

    /* Closing keeps the view in the path, so reopening returns to it. */
    await hideMain.click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}/settings` &&
        url.searchParams.get("sidepanel") === "true" &&
        url.searchParams.get("mainpanel") === "false",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeHidden({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toHaveAttribute("aria-hidden", "true");
    await expect(mainPanel(page)).toHaveAttribute("inert", "");
    /* The panel library's separator can expand a collapsed neighbor with
       pointer drag, arrows, or Enter. It must be absent while URL state owns a
       single-panel layout, or the visual split can diverge from that state. */
    await expect(page.getByTestId("workspace-panel-separator")).toHaveCount(0);
    const chatCard = page.getByTestId("side-panel");
    const visibleChatButtons = await chatCard
      .locator("button")
      .evaluateAll((buttons) =>
        buttons
          .map((button) => button.getAttribute("aria-label"))
          .filter((label) => label === "Show panel" || label === "Chats"),
      );
    expect(visibleChatButtons).toEqual(["Show panel", "Chats"]);
    const showMain = chatCard.getByRole("button", {
      name: "Show panel",
      exact: true,
    });
    await expect(showMain).toHaveAttribute("aria-expanded", "false");
    await expect(showMain).toBeFocused();
    expect(new URL(page.url()).pathname).toBe(
      `/${orgSlug}/agents/${projectId}/settings`,
    );

    /* Reopening must restore the same semantic and visual order. A panel
       library can otherwise append the restored node after Chat even though
       the first render was correct. */
    await showMain.click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}/settings` &&
        url.searchParams.get("sidepanel") === "true" &&
        url.searchParams.get("mainpanel") !== "false",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(page.getByTestId("workspace-panel-separator")).toHaveCount(1);
    await expect(hideMain).toBeFocused();
    expect(
      await workspaceColumns.evaluateAll((columns) =>
        columns.map((column) => column.getAttribute("data-testid")),
      ),
    ).toEqual([
      "workspace-main-panel",
      "workspace-panel-separator",
      "workspace-side-panel",
    ]);
    const reopenedMainBox = await page
      .getByTestId("workspace-main-panel")
      .boundingBox();
    const reopenedChatBox = await page
      .getByTestId("workspace-side-panel")
      .boundingBox();
    expect(reopenedMainBox).not.toBeNull();
    expect(reopenedChatBox).not.toBeNull();
    if (!reopenedMainBox || !reopenedChatBox) {
      throw new Error("Reopened workspace panels must be measurable");
    }
    expect(reopenedMainBox.x + reopenedMainBox.width).toBeLessThanOrEqual(
      reopenedChatBox.x,
    );

    /* A bookmark from before identity moved into the path lands on the same
       surface with both legacy routing keys retired. */
    await page.goto(
      `/${orgSlug}/agents?virtualmcpid=${projectId}&main=settings`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}/settings` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("main") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  /** The briefly shipped view-first route remains a compatibility adapter. */
  test("a legacy /agents/<view>?virtualmcpid= URL redirects to the agent surface", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "legacy path e2e");

    await page.goto(`/${orgSlug}/agents/settings?virtualmcpid=${projectId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}/settings` &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  test("legacy panel precedence and project-first custom views settle in one hop", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(
      request,
      orgSlug,
      "legacy precedence e2e",
    );
    const threadId = await createThread(request, orgSlug, projectId);

    /* Explicit `main` was authoritative in the view-first grammar. The path
       must not accidentally win just because the compatibility boundary now
       runs before the workspace mounts. */
    await page.goto(
      `/${orgSlug}/agents/code?virtualmcpid=${projectId}&main=settings&thread=${threadId}`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}/settings` &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* An opaque view-first path is recognizable only through its query-carried
       identity. Keep the outer adapter mounted until the active route snapshot
       commits, so the explicit legacy `main` cannot race onto the view name. */
    await page.goto(
      `/${orgSlug}/agents/custom-dashboard?virtualmcpid=${projectId}&main=settings&thread=${threadId}#opaque-view`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}/settings` &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId &&
        url.hash === "#opaque-view",
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* The project-first catch-all has both identities in its matched params,
       so an arbitrary view can move directly without a query discriminator. */
    await page.goto(
      `/${orgSlug}/agents/${projectId}/custom-dashboard?thread=${threadId}#section`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname ===
          `/${orgSlug}/agents/${projectId}/views/custom-dashboard` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId &&
        url.hash === "#section",
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* A retired visibility sentinel still canonicalizes the view path while
       expressing the closed panel solely as layout state. */
    await page.goto(`/${orgSlug}/agents/code?virtualmcpid=${projectId}&main=0`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}/site-editor/code` &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("mainpanel") === "false",
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* `overview` was emitted by the briefly shipped project-first grammar.
       It means this agent's overview, unlike legacy view-first
       `?main=overview`, which continues to mean organization Home. */
    await page.goto(`/${orgSlug}/agents/${projectId}/overview#overview`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.hash === "#overview",
      { timeout: SHELL_TIMEOUT_MS },
    );

    await page.goto(
      `/${orgSlug}/agents/code?virtualmcpid=${projectId}&main=overview#org-overview`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/home` &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null &&
        url.hash === "#org-overview",
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  /** A workspace root is canonical and never duplicates identity in search. */
  test("a lone /agents/<agentId> is the canonical agent workspace", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "lone id e2e");

    await page.goto(`/${orgSlug}/agents/${projectId}`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(chatPanel(page)).toHaveCount(0);
    const landed = new URL(page.url());
    expect(landed.pathname).toBe(`/${orgSlug}/agents/${projectId}`);
    expect(landed.searchParams.get("virtualmcpid")).toBeNull();
  });

  test("canonical paths outrank stale search-carried agent identity", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const pathAgentId = await createProject(
      request,
      orgSlug,
      "path identity e2e",
    );
    const staleAgentId = await createProject(
      request,
      orgSlug,
      "stale identity e2e",
    );

    /* Once identity is in a canonical agent path, an old query value is only
       residue. It is removed; it can never switch the mounted agent. */
    await page.goto(
      `/${orgSlug}/agents/${pathAgentId}/settings?virtualmcpid=${staleAgentId}`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${pathAgentId}/settings` &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(page.getByPlaceholder("Project name")).toHaveValue(
      "path identity e2e",
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* Org destinations never inherit a stale project scope either. Home is
       the one historical exception: a scoped Home URL meant "open agent", so
       its compatibility adapter promotes the id into the canonical path. */
    await page.goto(`/${orgSlug}/tasks?virtualmcpid=${staleAgentId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/tasks` &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );

    await page.goto(`/${orgSlug}/home?virtualmcpid=${staleAgentId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${staleAgentId}` &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  test("an agent-declared view keeps its namespace when its id collides", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const viewId = "reports";
    const viewTitle = "Agent-owned Reports App";
    const legacyCollisionId = "monitor";
    const legacyCollisionTitle = "Agent-owned Monitor App";
    const agentId = await createProject(
      request,
      orgSlug,
      "colliding view e2e",
      {
        layoutTabs: [
          { id: viewId, title: viewTitle },
          { id: legacyCollisionId, title: legacyCollisionTitle },
        ],
      },
    );
    const threadId = await createThread(request, orgSlug, agentId);

    await page.goto(
      `/${orgSlug}/agents/${agentId}?thread=${threadId}&sidepanel=true`,
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    const declaredView = page.getByRole("button", {
      name: viewTitle,
      exact: true,
    });
    await expect(declaredView).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await declaredView.click();

    /* The raw metadata id says `reports`, but its typed tab identity says this
       is an agent view. It must not be mistaken for the built-in organization
       Reports destination when navigation resolves it. */
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}/views/${viewId}` &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(
      page.getByRole("heading", { name: viewTitle, level: 1 }),
    ).toBeVisible();
    const declaredViewBreadcrumb = mainTopbarRegion(page, "left").getByRole(
      "navigation",
      { name: "Breadcrumb", exact: true },
    );
    const agentParent = await breadcrumbParent(
      page,
      declaredViewBreadcrumb,
      "colliding view e2e",
    );
    await expect(
      declaredViewBreadcrumb.locator('[aria-current="page"]'),
    ).toHaveCount(0);
    await expect(declaredViewBreadcrumb).not.toContainText(viewTitle);

    await agentParent.link.click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}` &&
        url.searchParams.get("thread") === threadId &&
        url.searchParams.get("sidepanel") === "true",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(chatPanel(page)).toBeVisible();

    // The sidebar Overview row is a real link (open-in-new-tab semantics), but
    // it must use the same agent-scoped search writer as every view button.
    await declaredView.click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}/views/${viewId}` &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );
    const projectOverview = page
      .locator('[data-slot="sidebar"]')
      .locator(`a[href^="/${orgSlug}/agents/${agentId}"]`)
      .filter({ hasText: "Home" })
      .first();
    await expect(projectOverview).toBeVisible();
    await projectOverview.click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}` &&
        url.searchParams.get("thread") === threadId &&
        url.searchParams.get("sidepanel") === "true",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(chatPanel(page)).toBeVisible();

    /* `/agents/<agent>/<view>` was a shipped project-first grammar. `monitor`
       used to be an unambiguous custom id, so the built-in CDN route must not
       shadow it with a newly chosen path name. */
    await page.goto(
      `/${orgSlug}/agents/${agentId}/${legacyCollisionId}?thread=${threadId}#monitor-view`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname ===
          `/${orgSlug}/agents/${agentId}/views/${legacyCollisionId}` &&
        url.searchParams.get("thread") === threadId &&
        url.searchParams.get("virtualmcpid") === null &&
        url.hash === "#monitor-view",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(
      page.getByRole("heading", { name: legacyCollisionTitle, level: 1 }),
    ).toBeVisible();
  });

  test("a populated thread reopens Chat on cold load unless search closes it", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const agentId = await createProject(request, orgSlug, "cold chat e2e");
    const threadId = await createThread(request, orgSlug, agentId);
    const message = `Persisted route turn ${crypto.randomUUID()}`;
    await populateThread(orgId, threadId, message);
    const route = `/${orgSlug}/agents/${agentId}?thread=${threadId}`;

    /* No panel preference in the URL: the loaded conversation reopens Chat
       alongside the route-owned agent overview. */
    await page.goto(route);
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      chatPanel(page).getByText(message, { exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    expect(new URL(page.url()).searchParams.has("sidepanel")).toBe(false);

    /* Explicit search is stronger than the populated-thread default. This is
       another document navigation, so it also covers initial hydration rather
       than only an in-app toggle. */
    await page.goto(`${route}&sidepanel=false`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(chatPanel(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("sidepanel")).toBe("false");
  });

  test("the Portuguese Tasks topbar keeps every action reachable at 320px", async ({
    authedPage: { page, orgSlug },
  }) => {
    await usePortugueseMobileViewport(page);
    await page.goto(`/${orgSlug}/tasks`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    const topbarActions = mainTopbarRegion(page, "right");
    const list = topbarActions.getByRole("button", {
      name: "visualização Lista",
      exact: true,
    });
    const board = topbarActions.getByRole("button", {
      name: "visualização Quadro",
      exact: true,
    });
    const create = topbarActions.getByRole("button", {
      name: "Nova tarefa",
      exact: true,
    });

    for (const control of [list, board, create]) {
      await expect(control).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await expect(control).toBeEnabled();
      await expect(control).toBeInViewport({ ratio: 1 });
    }

    await expect(board).toHaveAttribute("aria-pressed", "true");
    await list.click();
    await page.waitForURL((url) => url.searchParams.get("view") === "list", {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(list).toHaveAttribute("aria-pressed", "true");

    await board.click();
    await page.waitForURL((url) => url.searchParams.get("view") === null, {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(board).toHaveAttribute("aria-pressed", "true");

    await create.click();
    await expect(
      page.getByRole("dialog", { name: "Nova tarefa", exact: true }),
    ).toBeVisible();
  });

  test("the Portuguese Library topbar keeps every action reachable at 320px", async ({
    authedPage: { page, orgSlug },
  }) => {
    await usePortugueseMobileViewport(page);
    await page.goto(`/${orgSlug}/library`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    const topbarActions = mainTopbarRegion(page, "right");
    const controls = ["Atualizar", "Nova pasta", "Enviar arquivo"].map((name) =>
      topbarActions.getByRole("button", {
        name,
        exact: true,
      }),
    );

    for (const control of controls) {
      await expect(control).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await expect(control).toBeEnabled();
      await expect(control).toBeInViewport({ ratio: 1 });
    }

    const subheader = mainPanel(page).locator('[data-slot="main-subheader"]');
    const search = subheader.getByPlaceholder("Pesquisar todos os arquivos…");
    await expect(search).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(search).toBeInViewport({ ratio: 1 });

    await controls[1]?.click();
    await expect(
      page.getByRole("dialog", { name: "Nova pasta", exact: true }),
    ).toBeVisible();
  });

  test("the mobile view selector exposes its real active route option", async ({
    authedPage: { page, orgSlug },
  }) => {
    await usePortugueseMobileViewport(page);
    const agentId = await createProject(
      page.context().request,
      orgSlug,
      "mobile active option e2e",
    );

    await page.goto(`/${orgSlug}/agents/${agentId}/settings`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    const trigger = page.getByRole("combobox", {
      name: "Visualizar",
      exact: true,
    });
    await expect(trigger).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(trigger).toContainText("Configurações");
    await trigger.click();

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const activeOption = listbox.getByRole("option", {
      name: "Configurações",
      exact: true,
      selected: true,
    });
    await expect(activeOption).toBeVisible();
    await expect(activeOption).toHaveAttribute("aria-selected", "true");
    await expect(listbox.getByRole("option", { selected: true })).toHaveCount(
      1,
    );
  });

  test("mobile View trigger names the selected Chat surface", async ({
    authedPage: { page, orgSlug },
  }) => {
    await usePortugueseMobileViewport(page);
    const projectTitle = "Dynamic overview title e2e";
    const agentId = await createProject(
      page.context().request,
      orgSlug,
      projectTitle,
    );

    await page.goto(`/${orgSlug}/agents/${agentId}`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    const trigger = page.getByRole("combobox", {
      name: "Visualizar",
      exact: true,
    });
    await expect(trigger).toContainText(projectTitle, {
      timeout: SHELL_TIMEOUT_MS,
    });
    await trigger.click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "Chat", exact: true })
      .click();

    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toBeHidden();
    await expect(mainPanel(page)).toHaveAttribute("aria-hidden", "true");
    await expect(trigger).toContainText("Chat", {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(trigger).not.toContainText(projectTitle);
  });

  test("keyboard navigation restores focus across mobile surface and route replacements", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const agentId = await createProject(
      page.context().request,
      orgSlug,
      "mobile focus e2e",
    );
    await page.goto(`/${orgSlug}/agents/${agentId}/settings`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    const viewSelect = page.getByRole("combobox", {
      name: "View",
      exact: true,
    });
    await viewSelect.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "Chat", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) =>
        url.searchParams.get("sidepanel") === "true" &&
        url.searchParams.get("mainpanel") === "false",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(viewSelect).toBeFocused();

    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "Settings", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) =>
        url.searchParams.get("sidepanel") === "false" &&
        url.searchParams.get("mainpanel") === "true",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(viewSelect).toBeFocused();

    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "Tasks", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname === `/${orgSlug}/tasks`, {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(
      mainTopbarRegion(page, "left").getByRole("heading", {
        level: 1,
        name: "Tasks",
        exact: true,
      }),
    ).toBeFocused();
  });

  test("keyboard tab and breadcrumb navigation focus the new desktop route heading", async ({
    authedPage: { page, orgSlug },
  }) => {
    const projectTitle = "desktop focus e2e";
    const viewTitle = "Focus dashboard";
    const viewId = "focus-dashboard";
    const agentId = await createProject(
      page.context().request,
      orgSlug,
      projectTitle,
      { clonable: true, layoutTabs: [{ id: viewId, title: viewTitle }] },
    );
    await page.goto(`/${orgSlug}/agents/${agentId}`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    const homeBreadcrumb = mainTopbar(page).getByRole("link", {
      name: "Home",
      exact: true,
    });
    await homeBreadcrumb.focus();
    await page.setViewportSize({ width: 320, height: 720 });
    const responsiveViewSelect = page.getByRole("combobox", {
      name: "View",
      exact: true,
    });
    await expect(responsiveViewSelect).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(homeBreadcrumb).toBeFocused();

    const viewTab = mainTopbar(page).getByRole("button", {
      name: viewTitle,
      exact: true,
    });
    await viewTab.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) => url.pathname === `/${orgSlug}/agents/${agentId}/views/${viewId}`,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(
      mainTopbarRegion(page, "left").getByRole("heading", {
        level: 1,
        name: viewTitle,
        exact: true,
      }),
    ).toBeFocused();

    const projectParent = mainTopbar(page).getByRole("link", {
      name: projectTitle,
      exact: true,
    });
    await projectParent.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) => url.pathname === `/${orgSlug}/agents/${agentId}`,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(
      mainTopbarRegion(page, "left").getByRole("heading", {
        level: 1,
        name: projectTitle,
        exact: true,
      }),
    ).toBeFocused();

    // History navigation has no activating link to remember. If the previous
    // heading is removed, the resolved destination heading becomes the focus
    // target instead of leaving keyboard users at document.body.
    await page.goBack();
    await page.waitForURL(
      (url) => url.pathname === `/${orgSlug}/agents/${agentId}/views/${viewId}`,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(
      mainTopbarRegion(page, "left").getByRole("heading", {
        level: 1,
        name: viewTitle,
        exact: true,
      }),
    ).toBeFocused();
  });

  test("workspace history and breakpoints preserve a meaningful focus target", async ({
    authedPage: { page, orgSlug },
  }) => {
    const orgId = await findOrgId(page.context().request, orgSlug);
    const agentId = await createProject(
      page.context().request,
      orgSlug,
      "workspace focus e2e",
      { clonable: true },
    );
    const threadId = await createThread(
      page.context().request,
      orgSlug,
      agentId,
    );
    await populateThread(orgId, threadId, "Focus handoff chat context");

    // Toggling the active Site Editor tab is a search-only navigation that
    // collapses Main. Its visible semantic replacement lives in Chat.
    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor?thread=${threadId}&sidepanel=true&mainpanel=true`,
    );
    const activePreviewTab = mainPanel(page).getByRole("button", {
      name: "Preview",
      exact: true,
    });
    await activePreviewTab.focus();
    await pushSearchHistory(page, { mainpanel: "false" });
    await page.waitForURL(
      (url) => url.searchParams.get("mainpanel") === "false",
      { timeout: SHELL_TIMEOUT_MS },
    );
    const sidePanelCard = page.getByTestId("side-panel");
    await expect(
      sidePanelCard.getByRole("button", {
        name: "Show panel",
        exact: true,
      }),
    ).toBeFocused();

    await page.goBack();
    await page.waitForURL(
      (url) => url.searchParams.get("mainpanel") === "true",
      { timeout: SHELL_TIMEOUT_MS },
    );
    const restoredHideMain = mainPanel(page).getByRole("button", {
      name: "Hide panel",
      exact: true,
    });
    await expect(restoredHideMain).toBeFocused();

    await page.goForward();
    await page.waitForURL(
      (url) => url.searchParams.get("mainpanel") === "false",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(
      sidePanelCard.getByRole("button", {
        name: "Show panel",
        exact: true,
      }),
    ).toBeFocused();

    await page.goBack();
    await page.waitForURL(
      (url) => url.searchParams.get("mainpanel") === "true",
      { timeout: SHELL_TIMEOUT_MS },
    );
    const hideChat = mainPanel(page).getByRole("button", {
      name: "Hide chat",
      exact: true,
    });
    await hideChat.focus();
    await pushSearchHistory(page, { sidepanel: "false" });
    await page.waitForURL(
      (url) => url.searchParams.get("sidepanel") === "false",
      { timeout: SHELL_TIMEOUT_MS },
    );
    const showChat = mainPanel(page).getByRole("button", {
      name: "Show chat",
      exact: true,
    });
    await expect(showChat).toBeFocused();

    await page.goBack();
    await page.waitForURL(
      (url) => url.searchParams.get("sidepanel") === "true",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(hideChat).toBeFocused();

    await page.goForward();
    await page.waitForURL(
      (url) => url.searchParams.get("sidepanel") === "false",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(showChat).toBeFocused();

    // Crossing into the one-surface mobile shell can make either persistent
    // panel inert. Focus follows to the visible View switcher, then returns to
    // the exact desktop node only if the user leaves that handoff untouched.
    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor?thread=${threadId}&sidepanel=true&mainpanel=true`,
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    const mainFocusProbe = mainPanel(page);
    await mainFocusProbe.evaluate((element) => {
      element.tabIndex = -1;
      element.focus();
    });
    await expect(mainFocusProbe).toBeFocused();
    await page.setViewportSize({ width: 767, height: 720 });
    const mobileViewSelect = page.getByRole("combobox", {
      name: "View",
      exact: true,
    });
    await expect(mobileViewSelect).toBeFocused();
    await expect(mainFocusProbe).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(mainFocusProbe).toBeFocused();

    // A newer explicit focus move cancels restoration to the desktop source.
    await page.setViewportSize({ width: 767, height: 720 });
    await expect(mobileViewSelect).toBeFocused();
    const chatFocusProbe = chatPanel(page);
    await chatFocusProbe.evaluate((element) => {
      element.tabIndex = -1;
      element.focus();
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(chatFocusProbe).toBeFocused();
    await expect(mainFocusProbe).not.toBeFocused();

    // With no explicit side-panel preference, Main wins on mobile. The same
    // handoff works symmetrically for a focused Chat descendant.
    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor?thread=${threadId}&mainpanel=true`,
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    const defaultChatFocusProbe = chatPanel(page);
    await defaultChatFocusProbe.evaluate((element) => {
      element.tabIndex = -1;
      element.focus();
    });
    await expect(defaultChatFocusProbe).toBeFocused();
    await page.setViewportSize({ width: 767, height: 720 });
    await expect(mobileViewSelect).toBeFocused();
    await expect(defaultChatFocusProbe).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(defaultChatFocusProbe).toBeFocused();
  });

  test("Preview, Content, and Code are canonical Site Editor children", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const agentId = await createProject(
      request,
      orgSlug,
      "site editor routes e2e",
      { clonable: true },
    );
    const threadId = await createThread(request, orgSlug, agentId);
    const base = `/${orgSlug}/agents/${agentId}/site-editor`;

    for (const path of [base, `${base}/content`, `${base}/code`]) {
      await page.goto(`${path}?thread=${threadId}`);
      await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      const landed = new URL(page.url());
      expect(landed.pathname).toBe(path);
      expect(landed.searchParams.get("thread")).toBe(threadId);
      expect(landed.searchParams.get("virtualmcpid")).toBeNull();
      expect(landed.searchParams.get("main")).toBeNull();
    }

    /** Code kept its selected file in search; only its structural ownership
     *  and the agent identity move into the canonical path. */
    await page.goto(
      `/${orgSlug}/agents/code?virtualmcpid=${agentId}&thread=${threadId}&file=src%2Fapp.tsx`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `${base}/code` &&
        url.searchParams.get("file") === "src/app.tsx" &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );

    /** Older project-first Preview links predate the Site Editor name. */
    await page.goto(`/${orgSlug}/agents/${agentId}/preview?thread=${threadId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === base && url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  for (const { legacyShape, legacyPath } of [
    { legacyShape: "view-first", legacyPath: "agents/site-editor" },
    { legacyShape: "bare /agents", legacyPath: "agents" },
  ] as const) {
    test(`a ${legacyShape} Content link preserves its deep-link payload`, async ({
      authedPage: { page, orgSlug },
    }) => {
      const request = page.context().request;
      const agentId = await createProject(
        request,
        orgSlug,
        `${legacyShape} content payload e2e`,
        { clonable: true },
      );
      const threadId = await createThread(request, orgSlug, agentId);
      const payload = {
        contentPageId: "page-product-42",
        contentPath: "/products/café?variant=blue",
        contentPathTemplate: "/products/:slug",
      };
      const legacySearch = new URLSearchParams({
        virtualmcpid: agentId,
        thread: threadId,
        main: "content",
        ...payload,
      });

      await page.goto(`/${orgSlug}/${legacyPath}?${legacySearch}`);
      await page.waitForURL(
        (url) =>
          url.pathname ===
            `/${orgSlug}/agents/${agentId}/site-editor/content` &&
          url.searchParams.get("thread") === threadId &&
          url.searchParams.get("main") === null &&
          url.searchParams.get("virtualmcpid") === null &&
          url.searchParams.get("contentPageId") === payload.contentPageId &&
          url.searchParams.get("contentPath") === payload.contentPath &&
          url.searchParams.get("contentPathTemplate") ===
            payload.contentPathTemplate,
        { timeout: SHELL_TIMEOUT_MS },
      );
      await expect(mainPanel(page)).toBeVisible({
        timeout: SHELL_TIMEOUT_MS,
      });
    });
  }

  test("bare /agents carries parameterized app and file payloads through its identity redirect", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const agentId = await createProject(
      request,
      orgSlug,
      "bare parameterized payload e2e",
    );
    const threadId = await createThread(request, orgSlug, agentId);

    const connectionId = "connection_bare_agents_e2e";
    const toolName = "get_orders";
    const appSearch = new URLSearchParams({
      virtualmcpid: agentId,
      thread: threadId,
      main: `app:${connectionId}:${toolName}`,
      connection: connectionId,
      tool: toolName,
    });
    await page.goto(`/${orgSlug}/agents?${appSearch}`);
    await page.waitForURL(
      (url) =>
        url.pathname ===
          `/${orgSlug}/agents/${agentId}/apps/${connectionId}/${toolName}` &&
        url.searchParams.get("thread") === threadId &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("connection") === null &&
        url.searchParams.get("tool") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );

    const fileKey = `org-fs:outputs/${threadId}/quarterly café.pdf`;
    const fileSearch = new URLSearchParams({
      virtualmcpid: agentId,
      thread: threadId,
      main: `file:${encodeURIComponent(fileKey)}`,
      key: fileKey,
    });
    await page.goto(`/${orgSlug}/agents?${fileSearch}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}/outputs/file` &&
        url.searchParams.get("thread") === threadId &&
        url.searchParams.get("key") === fileKey &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  test("legacy /agents destination links preserve the destination-owned search", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const agentId = await createProject(
      request,
      orgSlug,
      "legacy agents destination payload e2e",
    );
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "legacy agents destination card" },
    );

    /* `?main=` was accepted on every workspace route. Passing through the
       short `/agents` identity adapter must not make the eventual Tasks route
       lose the card/filter state that belongs to it. */
    const boardSearch = new URLSearchParams({
      virtualmcpid: agentId,
      main: "board",
      task: item.id,
      view: "list",
      q: "legacy destination query",
      priority: "high",
      repo: "acme/storefront",
    });
    await page.goto(`/${orgSlug}/agents?${boardSearch}#board-state`);
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith(`/${orgSlug}/tasks/`) &&
        url.searchParams.get("main") === null &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("task") === null &&
        url.searchParams.get("view") === "list" &&
        url.searchParams.get("q") === "legacy destination query" &&
        url.searchParams.get("priority") === "high" &&
        url.searchParams.get("repo") === "acme/storefront" &&
        url.hash === "#board-state",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(page.getByTestId("task-detail")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    /* The project-first compatibility hop shares the same parent boundary.
       It must preserve Library state not encoded by the `files` view name. */
    const librarySearch = new URLSearchParams({
      path: "skills/catalog",
      skill: "checkout-audit",
      brand: "acme",
    });
    await page.goto(
      `/${orgSlug}/agents/${agentId}/files?${librarySearch}#library-state`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/library` &&
        url.searchParams.get("path") === "skills/catalog" &&
        url.searchParams.get("skill") === "checkout-audit" &&
        url.searchParams.get("brand") === "acme" &&
        url.searchParams.get("virtualmcpid") === null &&
        url.hash === "#library-state",
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  test("every durable legacy app link settles on the canonical app path", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const agentId = await createProject(request, orgSlug, "legacy app e2e");
    const threadId = await createThread(request, orgSlug, agentId);
    const connectionId = "connection_legacy_e2e";
    const toolName = "get_orders";
    const canonical = `/${orgSlug}/agents/${agentId}/apps/${connectionId}/${toolName}`;

    const assertCanonical = async () => {
      await page.waitForURL(
        (url) =>
          url.pathname === canonical &&
          url.searchParams.get("virtualmcpid") === null &&
          url.searchParams.get("main") === null &&
          url.searchParams.get("connection") === null &&
          url.searchParams.get("tool") === null,
        { timeout: SHELL_TIMEOUT_MS },
      );
    };

    /** View-first identity-in-search links were persisted by report setup. */
    await page.goto(
      `/${orgSlug}/agents/app?virtualmcpid=${agentId}&connection=${connectionId}&tool=${toolName}`,
    );
    await assertCanonical();

    /** Project-first links were also delivered before identity moved search. */
    await page.goto(
      `/${orgSlug}/agents/${agentId}/app?connection=${connectionId}&tool=${toolName}`,
    );
    await assertCanonical();

    /** The oldest thread URL encoded the whole pinned-view id in `?main=`. */
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&main=${encodeURIComponent(`app:${connectionId}:${toolName}`)}`,
    );
    await assertCanonical();
    expect(new URL(page.url()).searchParams.get("thread")).toBe(threadId);
  });

  /** A bare agent path and a view-first path were both shipped. Neither is a
   *  canonical workspace anymore, but both remain permanent input aliases. */
  test("unscoped legacy agent paths settle on canonical destinations", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const superAgentId = `decopilot_${orgId}`;
    const threadId = await createThread(request, orgSlug, superAgentId);

    await page.goto(`/${orgSlug}/agents`);
    await page.waitForURL((url) => url.pathname === `/${orgSlug}/home`, {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    /* This compatibility fallback must use the organization already mounted
       by the authenticated shell. A failed secondary org-list request used to
       replace this bookmark with Home and irreversibly drop its payload. */
    await page.goto(`/${orgSlug}/home`);
    await page.route("**/api/auth/organization/list", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "transient test failure" }),
      }),
    );
    await page.goto(
      `/${orgSlug}/agents/settings?thread=${threadId}&sidepanel=true#settings`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${superAgentId}/settings` &&
        url.searchParams.get("thread") === threadId &&
        url.searchParams.get("sidepanel") === "true" &&
        url.searchParams.get("virtualmcpid") === null &&
        url.hash === "#settings",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    await page.goBack();
    await page.waitForURL((url) => url.pathname === `/${orgSlug}/home`, {
      timeout: SHELL_TIMEOUT_MS,
    });
  });

  /**
   * REPRODUCED BUG. Home, Tasks, Reports and Library are ORG-LEVEL: they have
   * no `{-$project}` segment because they belong to the Super Agent. Opening
   * another agent's chat from one of them used to stay put and record that
   * agent in `?virtualmcpid=`, which the workspace then read back — so a whole
   * org-wide report served itself scoped to one project.
   *
   * A thread belongs where its agent lives, so the switch leaves for that
   * agent's own workspace and the search key is written nowhere.
   */
  test("an org-level destination never carries an agent in its search", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "org level e2e");
    const threadId = await createThread(
      request,
      orgSlug,
      projectId,
      "org level e2e chat",
    );

    await page.goto(`/${orgSlug}/reports?sidepanel=true`);
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    expect(new URL(page.url()).searchParams.get("virtualmcpid")).toBeNull();

    await page
      .getByRole("button", { name: "Chats", exact: true })
      .click({ timeout: SHELL_TIMEOUT_MS });
    const row = page.locator(`[data-task-id="${threadId}"]`);
    await expect(row).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await row.click();

    /* Landing on the agent workspace puts identity in the path. The assertion
       above pins that the org-level report never inherited it as a filter. */
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${projectId}` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  test("the short org links still redirect", async ({
    authedPage: { page, orgSlug },
  }) => {
    /* The Stripe return URL is the short `/members`; settings owns the page. */
    await page.goto(`/${orgSlug}/members`);
    await page.waitForURL(
      (url) => url.pathname === `/${orgSlug}/settings/members`,
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* The task board settings page was renamed; old links keep working. */
    await page.goto(`/${orgSlug}/settings/tasks`);
    await page.waitForURL(
      (url) => url.pathname === `/${orgSlug}/settings/task-board`,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  test("a destination collapses the chat, and the URL overrides that", async ({
    authedPage: { page, orgSlug },
  }) => {
    /* Going to Tasks shows Tasks: the destination names its own main view, so
       the chat starts collapsed beside it. */
    await page.goto(`/${orgSlug}/tasks`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(chatPanel(page)).toHaveCount(0);

    /* An explicit `?sidepanel=` outranks the route's default. */
    await page.goto(`/${orgSlug}/tasks?sidepanel=true`);
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toBeVisible();

    /* Closing the main panel can never leave the workspace blank: with the
       route default collapsing the chat, the fallback reopens it. */
    await page.goto(`/${orgSlug}/tasks?mainpanel=false`);
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toBeHidden();

    /* `?main=0` said the same thing before the view moved into the path. It is
       accepted as a legacy INPUT and rewritten, never written. */
    await page.goto(`/${orgSlug}/tasks?main=0`);
    await page.waitForURL(
      (url) =>
        url.searchParams.get("main") === null &&
        url.searchParams.get("mainpanel") === "false",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toBeHidden();

    /* `?sidepanel` shipped as `chat`/`0` before it was a boolean, and those
       URLs are in bookmarks. They keep their meaning instead of throwing. */
    await page.goto(`/${orgSlug}/tasks?sidepanel=chat`);
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await page.goto(`/${orgSlug}/tasks?sidepanel=0`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(chatPanel(page)).toHaveCount(0);
  });
});
