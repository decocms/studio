/**
 * E2E: the destination routes, and the legacy URLs that translate into them.
 *
 * The route grammar under test: **path = which page, search = how that page is
 * laid out.** Home, Tasks, Reports, Library and Discover are real path segments,
 * and project views live under `/projects/<agentId>`; `sidepanel`,
 * `mainpanel` and `thread` stay in search because they describe the layout —
 * whether each panel is open, and which conversation is in it.
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

import type { APIRequestContext, Page } from "@playwright/test";
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

test.describe("destination routes", () => {
  /** The waits below run to SHELL_TIMEOUT_MS, past Playwright's 30s per-test
   *  default — without this the test-level timeout fires first and reports a
   *  misleading "element not found". */
  test.describe.configure({ timeout: 240_000 });

  test("every destination owns its own URL, and reaching one mints no thread", async ({
    authedPage: { page, orgSlug },
  }) => {
    const orgId = await findOrgId(page.context().request, orgSlug);

    // Every page has a canonical URL; visibility stays in search.
    const destinations = [
      { path: `/${orgSlug}/home`, panel: mainPanel },
      { path: `/${orgSlug}/tasks`, panel: mainPanel },
      { path: `/${orgSlug}/library`, panel: mainPanel },
      { path: `/${orgSlug}/reports`, panel: mainPanel },
      { path: `/${orgSlug}/discover`, panel: mainPanel },
    ] as const;

    for (const { path, panel } of destinations) {
      await page.goto(path);
      await expect(panel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      /* The address is the assertion: a destination is a page, so nothing may
         bounce it onward to a thread or to another destination. */
      expect(new URL(page.url()).pathname).toBe(path);
    }

    /* Cold entry must not mint a conversation nobody asked for: five
       destinations visited, still not one thread in this org. */
    expect(await countOrgThreads(orgId)).toBe(0);
  });

  test("the org landing resolves into a destination", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.goto(`/${orgSlug}`);
    /* The resolver forwards a scope the URL names and otherwise lands on Home.
       Nothing names one here, so Home it is. */
    await page.waitForURL((url) => url.pathname === `/${orgSlug}/home`, {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  test("a legacy thread URL translates to the first-class shape", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "legacy shape e2e");
    const threadId = await createThread(request, orgSlug, projectId);

    // Project identity moves into the path; the chat stays in search.
    await page.goto(`/${orgSlug}/${threadId}?virtualmcpid=${projectId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${projectId}` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );

    // A link missing its project resolves to the persisted owner of the chat.
    await page.goto(`/${orgSlug}/${threadId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${projectId}` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  // A project chat keeps its owner through legacy destination redirects.
  for (const { main, destination } of [
    { main: "board", destination: "tasks" },
    { main: "files", destination: "library" },
  ] as const) {
    test(`a legacy main=${main} thread settles in its owning project after /${destination}`, async ({
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
          url.pathname ===
          (main === "board"
            ? `/${orgSlug}/projects/${projectId}/tasks`
            : `/${orgSlug}/projects/${projectId}`),
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
    await page.goto(`/${orgSlug}/tasks?task=${item.id}`);
    await page.waitForURL(
      (url) =>
        url.pathname === cardPath && url.searchParams.get("task") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* An unknown key lands on the board, not an error page — the card was
       probably deleted, and the board is where you would look next. */
    await page.goto(`/${orgSlug}/t/NOPE-99`);
    await page.waitForURL((url) => url.pathname === `/${orgSlug}/tasks`, {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  /**
   * The main-panel view is a path segment in the project, and whether the panel is
   * OPEN is a separate boolean — which is what lets a closed panel keep
   * remembering its view. `?main=` said both at once and is accepted forever as
   * a legacy INPUT: it is in bookmarks and in mail already delivered.
   */
  test("a view is a path segment, and a legacy ?main= still lands on it", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "panel path e2e");

    // The previously shipped view-first shape promotes project identity into the path.
    await page.goto(`/${orgSlug}/agents/settings?virtualmcpid=${projectId}`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    /* Closing keeps the view in the path, so reopening returns to it. */
    await page.goto(
      `/${orgSlug}/agents/settings?virtualmcpid=${projectId}&mainpanel=false`,
    );
    await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(mainPanel(page)).toBeHidden({ timeout: SHELL_TIMEOUT_MS });
    expect(new URL(page.url()).pathname).toBe(
      `/${orgSlug}/projects/${projectId}/settings`,
    );

    /* A bookmark from before the split lands on the same view, with `main`
       retired out of the URL. */
    await page.goto(
      `/${orgSlug}/agents?virtualmcpid=${projectId}&main=settings`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${projectId}/settings` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("main") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  /** The two-segment shape every link minted before the project moved to
   *  search still carries — including report mail, whose CTA an external
   *  service persists and re-sends for orgs that never re-onboard. It must
   *  redirect and keep the view's own payload. */
  test("a legacy /agents/<project>/<view> URL redirects into its canonical project path", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "legacy path e2e");

    await page.goto(`/${orgSlug}/agents/${projectId}/settings`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${projectId}/settings` &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  /** A bookmarked project with no view moves into `?virtualmcpid=` too. */
  test("a lone /agents/<projectId> redirects into the canonical project root", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "lone id e2e");

    await page.goto(`/${orgSlug}/agents/${projectId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${projectId}` &&
        url.searchParams.get("virtualmcpid") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  test("unscoped legacy views resolve without mistaking the view for a project", async ({
    authedPage: { page, orgSlug },
  }) => {
    const orgId = await findOrgId(page.context().request, orgSlug);
    const agentId = `decopilot_${orgId}`;
    for (const view of [
      "site-editor",
      "preview",
      "content",
      "settings",
      "board",
    ]) {
      await page.goto(`/${orgSlug}/agents/${view}`);
      await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await page.waitForURL(
        (url) => url.pathname.startsWith(`/${orgSlug}/projects/${agentId}`),
        { timeout: SHELL_TIMEOUT_MS },
      );
      expect(new URL(page.url()).searchParams.get("virtualmcpid")).toBeNull();
      await expect(
        page.getByText("Agent not found", { exact: true }),
      ).toHaveCount(0);
    }
    for (const view of ["preview", "content"]) {
      await page.goto(`/${orgSlug}/home?main=${view}`);
      await page.waitForURL(
        (url) =>
          url.pathname.startsWith(`/${orgSlug}/projects/${agentId}/`) &&
          !url.searchParams.has("main"),
        { timeout: SHELL_TIMEOUT_MS },
      );
      await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    }
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

    /* Landing on the agents route, the scope is legitimate — that route is one
       of the two that resolve it. The assertion that matters for this test is
       the one above, on `/reports`, where it must never appear. */
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${projectId}` &&
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
