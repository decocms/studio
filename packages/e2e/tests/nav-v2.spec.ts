/**
 * E2E: the first-class navigation (`nav_v2` org flag).
 *
 * With the flag OFF the sidebar renders the chat list; with it ON the sidebar
 * renders destinations (Home, Tasks, Library) and the chat list moves into a
 * menu at the top of the chat panel. Reports is conditional: it joins the list
 * ONLY once the org actually has a Commerce Discovery report, so both the
 * absent and present cases are asserted here.
 *
 * Wire-contract strings (flag name, `?main=` values, labels) are inlined on
 * purpose — this suite owns its contract (see ban-e2e-app-imports).
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
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

/** Turn the flag on the way a user would: the org settings switch. */
async function enableNavV2(page: Page, orgSlug: string): Promise<void> {
  await page.goto(`/${orgSlug}/settings/general`);
  const toggle = page.getByRole("switch", { name: /first-class navigation/i });
  await toggle.waitFor({ state: "visible", timeout: SHELL_TIMEOUT_MS });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
}

/** Resolve the org id for a slug via Better Auth's organization list. */
async function findOrgId(
  request: APIRequestContext,
  orgSlug: string,
): Promise<string> {
  const res = await request.get("/api/auth/organization/list");
  if (!res.ok()) throw new Error(`organization/list → HTTP ${res.status()}`);
  const body = (await res.json()) as
    | Array<{ id: string; slug: string }>
    | { data?: Array<{ id: string; slug: string }> };
  const orgs = Array.isArray(body) ? body : (body.data ?? []);
  const org = orgs.find((o) => o.slug === orgSlug);
  if (!org) throw new Error(`org ${orgSlug} not found in organization/list`);
  return org.id;
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

  test("flag off keeps the chat list in the sidebar", async ({
    authedPage: { page, orgSlug },
  }) => {
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

  test("flag on lists destinations and moves chats to the chat header", async ({
    authedPage: { page, orgSlug },
  }) => {
    await enableNavV2(page, orgSlug);
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

  test("Reports is hidden until the org has a report, then opens the report app", async ({
    authedPage: { page, orgSlug },
  }) => {
    await enableNavV2(page, orgSlug);
    await page.goto(`/${orgSlug}`);
    await expandSidebar(page, "Home");

    // No Commerce Discovery connection yet → no Reports destination.
    await expect(
      page.getByRole("button", { name: "Tasks", exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      page.getByRole("button", { name: "Reports", exact: true }),
    ).toHaveCount(0);

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
});
