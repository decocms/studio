/**
 * E2E: the first-class navigation (`nav_v2` org flag).
 *
 * ON (the seeded default for new orgs) renders destinations and moves the chat
 * list into the chat panel's menu; OFF is the opt-out and is set up as one here.
 * Reports joins the list only once the org has a Commerce Discovery report, so
 * both the absent and present cases are asserted.
 *
 * Wire-contract strings (flag name, `?main=` values, labels) are inlined on
 * purpose — this suite owns its contract (see ban-e2e-app-imports).
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { connectDevDb } from "../fixtures/db";
import {
  callSelfMcpTool,
  createHttpConnection,
  findOrgId,
} from "../fixtures/mcp-tools";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../fixtures/test-mcp-server";
import { expect, test } from "../fixtures/test";

/** Wire contract: the org's well-known Commerce Discovery connection id and the
 *  report tool the Reports destination opens. */
const cdConnectionId = (orgId: string) => `${orgId}_commerce-discovery`;
const REPORT_TOOL = "get_my_diagnostic";
const SITE_URL = "https://minha-loja.example";

/** Wire contract: the well-known Decopilot (Super Agent) id, `decopilot_<orgId>`. */
const decopilotId = (orgId: string) => `decopilot_${orgId}`;

/** Cold-Vite route compiles can take a minute+ on a loaded box; this spec
 *  crosses three lazy routes (settings, shell, report app). */
const SHELL_TIMEOUT_MS = 90_000;

/**
 * The sidebar starts collapsed to its icon rail; open it so labels render.
 * `settled` is a label only the EXPANDED sidebar shows, so this can't be fooled
 * by a same-named control elsewhere in the shell.
 */
async function expandSidebar(page: Page, settled: string) {
  const trigger = page.getByRole("button", { name: /toggle sidebar/i }).first();
  const label = page
    .getByRole("button", { name: settled, exact: true })
    .first();
  // Retry rather than probing once: a single count() races the sidebar's first
  // paint, and a mistimed click collapses an already-open sidebar. Later rounds
  // reload — ORGANIZATION_SETTINGS_GET degrades to empty flags on a failed
  // read, which renders the whole flag-off sidebar until the next fetch.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await page.reload();
    await trigger.waitFor({ state: "visible", timeout: SHELL_TIMEOUT_MS });
    if (await label.isVisible().catch(() => false)) return;
    await trigger.click();
    const shown = await label
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) return;
  }
  throw new Error(`sidebar never showed "${settled}"`);
}

/** Opt out the way a user would: the org settings switch, which a new org
 *  finds already on. Persists an explicit `nav_v2: false`. */
async function disableNavV2(page: Page, orgSlug: string): Promise<void> {
  await page.goto(`/${orgSlug}/settings/general`);
  const toggle = page.getByRole("switch", { name: /first-class navigation/i });
  await toggle.waitFor({ state: "visible", timeout: SHELL_TIMEOUT_MS });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
}

/**
 * Drop the creation-time `nav_v2` seed so the flag reads UNSET again.
 *
 * Raw SQL because ORGANIZATION_SETTINGS_UPDATE shallow-merges the flags bag and
 * has no way to remove a key — the state an org created before the seed is in
 * is unreachable through the tool API.
 */
async function clearSeededNavV2(orgId: string): Promise<void> {
  const db = await connectDevDb();
  try {
    await db.query(
      `UPDATE organization_settings
          SET flags = flags - 'nav_v2'
        WHERE "organizationId" = $1`,
      [orgId],
    );
  } finally {
    await db.end();
  }
}

/** Wire contract: the repo a coding agent is created against. Kept distinct
 *  from every agent title below so the sidebar's label source is unambiguous. */
const CODING_AGENT_REPO = "nav-v2-e2e";

/** A repo-backed ("coding") agent — the sidebar lists one row per repo. */
async function createCodingAgent(
  request: APIRequestContext,
  orgSlug: string,
  title: string,
): Promise<{ item: { id: string } }> {
  const conn = await createHttpConnection(request, orgSlug, {
    title: "github-placeholder",
    url: "http://127.0.0.1:3000/",
  });
  return await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title,
        status: "active",
        pinned: false,
        connections: [{ connection_id: conn.id }],
        metadata: {
          githubRepo: {
            url: `https://github.com/example/${CODING_AGENT_REPO}`,
            owner: "example",
            name: CODING_AGENT_REPO,
            connectionId: conn.id,
          },
        },
      },
    },
  );
}

/** A Commerce Discovery MCP that answers with one completed diagnostic. */
function startDiagnosticMcp(): Promise<TestMcpServer> {
  return startTestMcpServer({
    tools: [
      {
        name: REPORT_TOOL,
        description: "Return the diagnostic for the store.",
        outputSchema: {
          diagnostic: z
            .object({
              url: z.string(),
              scope: z.string(),
              scanned_at: z.string().nullable(),
            })
            .nullable(),
        },
        handler: () => ({
          diagnostic: {
            url: SITE_URL,
            scope: "private",
            scanned_at: "2026-07-10T12:00:00.000Z",
          },
        }),
      },
    ],
  });
}

test.describe("first-class navigation", () => {
  /** The expects below wait up to SHELL_TIMEOUT_MS, which is longer than
   *  Playwright's 30s default per-test timeout — without this the test-level
   *  timeout fires first and reports a misleading "element not found". */
  test.describe.configure({ timeout: 240_000 });

  test("a new org lands on the first-class navigation with nothing configured", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.goto(`/${orgSlug}`);
    await expandSidebar(page, "Home");

    await expect(
      page.getByRole("button", { name: "Home", exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      page.getByRole("button", { name: "Library", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tasks", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /filter chats/i }),
    ).toHaveCount(0);
  });

  test("the seed stores nav_v2 rather than resolving it at read time", async ({
    authedPage: { page, orgSlug },
  }) => {
    const orgId = await findOrgId(page.context().request, orgSlug);
    const db = await connectDevDb();
    try {
      const { rows } = await db.query<{ nav_v2: string | null }>(
        `SELECT flags ->> 'nav_v2' AS nav_v2
           FROM organization_settings
          WHERE "organizationId" = $1`,
        [orgId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.nav_v2).toBe("true");
    } finally {
      await db.end();
    }
  });

  test("opting out from settings brings the chat list back to the sidebar", async ({
    authedPage: { page, orgSlug },
  }) => {
    await disableNavV2(page, orgSlug);
    await page.goto(`/${orgSlug}`);
    await expandSidebar(page, "Filter chats");

    await expect(
      page.getByRole("button", { name: "Library", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Chats", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /filter chats/i }).first(),
    ).toBeVisible();
  });

  test("the first-class sidebar lists destinations and moves chats to the chat header", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.goto(`/${orgSlug}`);
    await expandSidebar(page, "Home");

    const home = page.getByRole("button", { name: "Home", exact: true });
    const library = page.getByRole("button", { name: "Library", exact: true });
    const tasks = page.getByRole("button", { name: "Tasks", exact: true });
    await expect(home).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(library).toBeVisible();
    await expect(tasks).toBeVisible();

    // Overview and Automations left the top tab bar.
    await expect(
      page.getByRole("button", { name: "Overview", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Automations", exact: true }),
    ).toHaveCount(0);

    // Single-teammate: no agent is named or picked anywhere in the shell.
    await expect(page.getByText("Super Agent", { exact: true })).toHaveCount(0);

    await library.click();
    await expect(page).toHaveURL(/[?&]main=files\b/);

    await tasks.click();
    await expect(page).toHaveURL(/[?&]main=board\b/);

    await home.click();
    await expect(page).toHaveURL(/[?&]main=overview\b/);

    // Both collapse controls live in the main header while it is open.
    const hideChat = page.getByRole("button", { name: "Hide chat" });
    const hidePanel = page.getByRole("button", { name: "Hide panel" });
    await expect(hideChat).toBeVisible();
    await expect(hidePanel).toBeVisible();

    await hideChat.click();
    await expect(page).toHaveURL(/[?&]sidepanel=0\b/);
    await page.getByRole("button", { name: "Show chat" }).click();
    await expect(page).toHaveURL(/[?&]sidepanel=chat\b/);

    await hidePanel.click();
    await expect(page).toHaveURL(/[?&]main=0\b/);
    await page.getByRole("button", { name: "Show panel" }).click();

    // The chat list now lives behind the chat panel's threads menu.
    const threads = page.getByRole("button", { name: "Chats", exact: true });
    await expect(threads).toBeVisible();
    await threads.click();
    await expect(
      page.getByRole("button", { name: /filter chats/i }).first(),
    ).toBeVisible();
  });

  test("Reports offers a diagnostic until the org has a report, then opens the report app", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.goto(`/${orgSlug}`);
    await expandSidebar(page, "Home");

    // No Commerce Discovery connection yet → the empty state, which starts one.
    await expect(
      page.getByRole("button", { name: "Tasks", exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await page
      .getByRole("button", { name: "Reports", exact: true })
      .click({ timeout: SHELL_TIMEOUT_MS });
    await expect(page).toHaveURL(/[?&]main=reports\b/);
    await expect(page.getByText("No reports yet")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(
      page.getByRole("button", { name: "Start diagnostic" }),
    ).toBeVisible();

    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const mcp = await startDiagnosticMcp();
    try {
      await callSelfMcpTool(request, orgSlug, "COLLECTION_CONNECTIONS_CREATE", {
        data: {
          id: cdConnectionId(orgId),
          title: "Commerce Discovery (e2e)",
          connection_type: "HTTP",
          connection_url: mcp.url,
          metadata: { siteUrl: SITE_URL },
        },
      });

      await page.goto(`/${orgSlug}`);
      await expandSidebar(page, "Home");

      const reports = page.getByRole("button", {
        name: "Reports",
        exact: true,
      });
      await expect(reports).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

      await reports.click();
      // The destination opens the report's MCP app as the main panel view.
      await expect(page).toHaveURL(new RegExp(`[?&]main=[^&]*${REPORT_TOOL}`));
    } finally {
      await mcp.stop();
    }
  });

  test("a reports-only org inherits the first-class navigation when nav_v2 is unset", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { reports_only: true },
    });
    await clearSeededNavV2(orgId);

    await page.goto(`/${orgSlug}`);
    await expandSidebar(page, "Home");

    await expect(
      page.getByRole("button", { name: "Home", exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      page.getByRole("button", { name: "Tasks", exact: true }),
    ).toBeVisible();
  });

  test("an explicit nav_v2:false overrides reports_only", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { reports_only: true, nav_v2: false },
    });

    await page.goto(`/${orgSlug}`);
    await expandSidebar(page, "Filter chats");

    await expect(
      page.getByRole("button", { name: "Home", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /filter chats/i }).first(),
    ).toBeVisible();
  });

  test("opening a destination from a coding agent's thread returns to the Super Agent", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);

    const agent = await createCodingAgent(request, orgSlug, "coding agent e2e");
    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: agent.item.id } },
    );

    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}`,
    );
    await expandSidebar(page, "Home");

    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`[?&]virtualmcpid=${decopilotId(orgId)}\\b`),
    );
    await expect(page).toHaveURL(/[?&]main=board\b/);
  });

  test("a coding agent is listed by its title, and follows a rename", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    const agent = await createCodingAgent(request, orgSlug, "before rename");
    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: agent.item.id } },
    );

    // The settings tab is driven by `?main=`, not `?tab=`.
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=settings`,
    );
    await expandSidebar(page, "Home");

    const sidebar = page.locator('[data-sidebar="content"]');
    const row = (name: string) =>
      sidebar.getByRole("button", { name, exact: true });
    await expect(row("before rename")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(row(CODING_AGENT_REPO)).toHaveCount(0);

    // Rename the way a user does — the identity form autosaves on blur.
    const titleInput = page.getByPlaceholder("Agent name");
    await expect(titleInput).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await titleInput.fill("after rename");
    await titleInput.blur();

    await expect(row("after rename")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(row("before rename")).toHaveCount(0);
    await expect(row(CODING_AGENT_REPO)).toHaveCount(0);
  });
});
