/**
 * E2E: the destination routes, and the legacy URLs that translate into them.
 *
 * The route grammar under test: **path = which page, search = how that page is
 * laid out.** Home, Chat, Tasks, Reports and Library are real path segments,
 * and so is the main-panel view (`/agents/<view>`); `sidepanel`,
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
): Promise<string> {
  const connection = await createHttpConnection(request, orgSlug, {
    title: `${title} placeholder`,
    url: "http://127.0.0.1:1/unused",
  });
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

    /** Chat is the one destination that declares no default main view, so it is
     *  the one that opens on the chat panel instead of the main one. */
    const destinations = [
      { path: `/${orgSlug}/home`, panel: mainPanel },
      { path: `/${orgSlug}/tasks`, panel: mainPanel },
      { path: `/${orgSlug}/library`, panel: mainPanel },
      { path: `/${orgSlug}/reports`, panel: mainPanel },
      { path: `/${orgSlug}/agents`, panel: chatPanel },
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

    /* The agent survives as `?virtualmcpid=` and the thread id moves out of
       the path into `?thread=`. The path is what changes, not the param. */
    await page.goto(`/${orgSlug}/${threadId}?virtualmcpid=${projectId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents` &&
        url.searchParams.get("virtualmcpid") === projectId &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );

    /* No agent named: no `?virtualmcpid=` either, which is how the Super
       Agent reads under this grammar. */
    await page.goto(`/${orgSlug}/${threadId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("thread") === threadId,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  /**
   * `main=board` on a coding agent always showed the ORG-WIDE board, so
   * carrying the project onto `/tasks` would invent a filter the old URL never
   * had. `main` is dropped too — the path says which page this is now.
   */
  for (const { main, destination } of [
    { main: "board", destination: "tasks" },
    { main: "files", destination: "library" },
  ] as const) {
    test(`a legacy main=${main} URL lands on /${destination} without the project`, async ({
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
        (url) => url.pathname === `/${orgSlug}/${destination}`,
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
   * The main-panel view is a path segment on Chat, and whether the panel is
   * OPEN is a separate boolean — which is what lets a closed panel keep
   * remembering its view. `?main=` said both at once and is accepted forever as
   * a legacy INPUT: it is in bookmarks and in mail already delivered.
   */
  test("a view is a path segment, and a legacy ?main= still lands on it", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "panel path e2e");

    /* The address a view is written as: the VIEW is the segment, the project
       is `?virtualmcpid=`. */
    await page.goto(`/${orgSlug}/agents/settings?virtualmcpid=${projectId}`);
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    /* Closing keeps the view in the path, so reopening returns to it. */
    await page.goto(
      `/${orgSlug}/agents/settings?virtualmcpid=${projectId}&mainpanel=false`,
    );
    await expect(mainPanel(page)).toBeHidden({ timeout: SHELL_TIMEOUT_MS });
    expect(new URL(page.url()).pathname).toBe(`/${orgSlug}/agents/settings`);

    /* A bookmark from before the split lands on the same view, with `main`
       retired out of the URL. */
    await page.goto(
      `/${orgSlug}/agents?virtualmcpid=${projectId}&main=settings`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/settings` &&
        url.searchParams.get("virtualmcpid") === projectId &&
        url.searchParams.get("main") === null,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  /** The two-segment shape every link minted before the project moved to
   *  search still carries — including report mail, whose CTA an external
   *  service persists and re-sends for orgs that never re-onboard. It must
   *  redirect and keep the view's own payload. */
  test("a legacy /agents/<project>/<view> URL redirects into ?virtualmcpid=", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "legacy path e2e");

    await page.goto(`/${orgSlug}/agents/${projectId}/settings`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/settings` &&
        url.searchParams.get("virtualmcpid") === projectId,
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  });

  /** A bookmarked project with no view moves into `?virtualmcpid=` too. */
  test("a lone /agents/<projectId> redirects into ?virtualmcpid=", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug, "lone id e2e");

    await page.goto(`/${orgSlug}/agents/${projectId}`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents` &&
        url.searchParams.get("virtualmcpid") === projectId,
      { timeout: SHELL_TIMEOUT_MS },
    );
  });

  /** REGRESSION, kept after the project moved to search. One optional segment
   *  makes a lone `/agents/<view>` unambiguous to the ROUTER, but `beforeLoad`
   *  still classifies it and sweeps anything that is not a known view into
   *  `?virtualmcpid=`. A view misclassified there hands a VIEW name to the agent
   *  lookup and the workspace reads "Agent not found" — this pins that. */
  test("a lone /agents/<view> is the view, not a project named after it", async ({
    authedPage: { page, orgSlug },
  }) => {
    for (const view of [
      "site-editor",
      /* Two names the app no longer writes — `preview` before the rename,
         `content` before Content became `?main=content` on the Site Editor —
         both still VIEWS, and both still resolvable from a bookmark. */
      "preview",
      "content",
      "settings",
      "board",
    ]) {
      await page.goto(`/${orgSlug}/agents/${view}`);
      await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      /* The workspace, not the not-found page a misclassified segment gives. */
      await expect(chatPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      expect(new URL(page.url()).pathname).toBe(`/${orgSlug}/agents/${view}`);
      /* Not swept into the scope by the beforeLoad classifier. */
      expect(new URL(page.url()).searchParams.get("virtualmcpid")).toBeNull();

      /* No body assertion for `content` here, deliberately. Content is gated
         on the agent having SOURCE (`resolveSurfaceTabs` returns [] without
         it), and this org's only agent is the Super Agent — so the view
         legitimately falls back to the default rather than rendering
         Content's empty state. What this test owns is the CLASSIFIER: the
         segment stays a view and is not swept into `?virtualmcpid=`, which
         the assertions above prove. */
    }

    /* The legacy translator mints exactly this shape off a project-less page,
       and rewrites the retired `preview` to the segment that owns the view. */
    await page.goto(`/${orgSlug}/home?main=preview`);
    await page.waitForURL(
      (url) => url.pathname === `/${orgSlug}/agents/site-editor`,
      {
        timeout: SHELL_TIMEOUT_MS,
      },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    /* INVERTED: `main=content` used to be retired into a `content` segment
       like every other view. It is Content's own address now — the Site
       Editor segment KEEPS the param instead of translating it away, and the
       redirect settles rather than re-firing on its own output. */
    await page.goto(`/${orgSlug}/home?main=content`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/site-editor` &&
        url.searchParams.get("main") === "content",
      { timeout: SHELL_TIMEOUT_MS },
    );
    await expect(mainPanel(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
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
        url.pathname === `/${orgSlug}/agents` &&
        url.searchParams.get("virtualmcpid") === projectId &&
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
