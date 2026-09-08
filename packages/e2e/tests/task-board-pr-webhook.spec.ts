/**
 * The GitHub webhook → PR card path, end to end over the wire.
 *
 * A PR card's checks and preview url used to be poll-only, so they landed
 * minutes after GitHub had them. GitHub now posts `check_suite` /
 * `issue_comment` to `/api/_github/webhook`, which re-reads the card and pushes
 * it on the org's `/watch` stream. This spec walks that whole chain:
 *
 *   HMAC-signed delivery → repo/PR reverse lookup → fresh GitHub read →
 *   card cache write → SSE push → the open dialog's checks + preview control.
 *
 * GitHub is a local MCP server (the card path reads GitHub through an
 * `mcp-github` connection, not the REST stub), whose answers flip mid-test from
 * "CI running, no preview" to "CI passed, preview url in the deploy check's
 * output" — the shape where no bot ever comments the url, only the check does.
 *
 * `GITHUB_WEBHOOK_SECRET` is set on the API server by playwright.config.ts;
 * the literal is duplicated here by hand (the config isn't a spec module),
 * matching how commerce-diagnostic-share.spec.ts carries the vault token.
 */

import { createHmac } from "node:crypto";
import { z } from "zod";
import type { APIRequestContext } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { startTestMcpServer } from "../fixtures/test-mcp-server";
import { expect, test } from "../fixtures/test";

const WEBHOOK_SECRET = "e2e-github-webhook-secret";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
}
interface TaskBoardItemPr {
  url: string;
  number: number;
  checksStatus: "pending" | "passing" | "failing" | null;
  previewUrl: string | null;
  state: "open" | "closed" | null;
}
interface PrsWatchEvent {
  type: string;
  subject: string;
  data: { id: string; prs: TaskBoardItemPr[] };
}

declare global {
  interface Window {
    __prsEvents?: PrsWatchEvent[];
  }
}

/** GitHub's own signature scheme: HMAC-SHA256 over the exact request bytes. */
function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function postWebhook(
  request: APIRequestContext,
  event: string,
  payload: unknown,
  signature?: string,
) {
  const body = JSON.stringify(payload);
  return request.post("/api/_github/webhook", {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature ?? sign(body),
    },
  });
}

/**
 * A stand-in for the org's `mcp-github` connection. One `pull_request_read`
 * tool dispatching on `method`, exactly as the card path calls it, plus the
 * deployment lookup it falls back to.
 *
 * `state.ciDone` flips what the check runs report — an in-flight deploy first,
 * then a finished one whose output carries the preview url.
 */
async function startGithubMcp(state: { ciDone: boolean }, previewUrl: string) {
  return startTestMcpServer({
    tools: [
      {
        name: "pull_request_read",
        inputSchema: {
          method: z.string(),
          owner: z.string().optional(),
          repo: z.string().optional(),
          pullNumber: z.number().optional(),
        },
        handler: (args) => {
          switch (args.method) {
            case "get":
              return {
                title: "Ship the widget",
                body: "",
                state: "open",
                draft: false,
                merged: false,
                mergeable: true,
                updated_at: new Date().toISOString(),
                head: { sha: "a".repeat(40) },
              };
            case "get_status":
              return { sha: "a".repeat(40), statuses: [] };
            case "get_check_runs":
              return {
                check_runs: [
                  state.ciDone
                    ? {
                        id: 1,
                        name: "Deploy Preview",
                        status: "completed",
                        conclusion: "success",
                        html_url: "https://github.com/x/y/runs/1",
                        // The point of the test: the url is HERE, not in a comment.
                        output: { summary: `Deployed to ${previewUrl}` },
                      }
                    : {
                        id: 1,
                        name: "Deploy Preview",
                        status: "in_progress",
                        conclusion: null,
                        html_url: "https://github.com/x/y/runs/1",
                        output: { summary: "Building…" },
                      },
                ],
              };
            // No bot comment, ever — the case the comment-only path missed.
            case "get_comments":
              return [];
            default:
              return {};
          }
        },
      },
      {
        name: "GET_PREVIEW_DEPLOYMENT",
        inputSchema: {
          owner: z.string().optional(),
          repo: z.string().optional(),
          sha: z.string().optional(),
        },
        handler: () => ({ environmentUrl: null }),
      },
    ],
  });
}

/** The org-level GitHub connection the card path resolves for any repo. */
async function createGithubConnection(
  request: APIRequestContext,
  orgSlug: string,
  connectionUrl: string,
): Promise<void> {
  const created = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_CONNECTIONS_CREATE",
    {
      data: {
        title: `GitHub ${Date.now()}`,
        app_name: "mcp-github",
        connection_type: "HTTP",
        connection_url: connectionUrl,
      },
    },
  );
  expect(created.item.id).toBeTruthy();
}

test.describe("github webhook → PR card", () => {
  test("a check_suite delivery refreshes the card, pushes it, and updates the dialog", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    // Tenant-scoped repo name so parallel workers can't collide on the lookup.
    const repoOwner = "acme-e2e";
    const repoName = `widget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const prNumber = 4242;
    const prUrl = `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`;
    const previewUrl = `https://${repoName}.deco.site`;

    const state = { ciDone: false };
    const github = await startGithubMcp(state, previewUrl);
    try {
      await createGithubConnection(request, orgSlug, github.url);

      const { item } = await call<{ item: TaskBoardItem }>(
        "TASK_BOARD_ITEM_CREATE",
        { title: "Ship the widget", status: "in_review", prUrl },
      );

      // Warm the card while CI is still running: pending, and no preview yet.
      // The first read is a cache placeholder (it never blocks on GitHub), so
      // poll until the live read lands.
      await expect
        .poll(
          async () =>
            (
              await call<{ prs: TaskBoardItemPr[] }>(
                "TASK_BOARD_ITEM_PRS_GET",
                {
                  taskBoardItemId: item.id,
                },
              )
            ).prs[0],
          { timeout: 30_000 },
        )
        .toMatchObject({ checksStatus: "pending", previewUrl: null });

      // The dialog, open on that card, showing the pre-webhook state.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/${orgSlug}/tasks`);
      await page.locator('button:has-text("Ship the widget")').first().click();
      await expect(page.getByText("Checks pending")).toBeVisible({
        timeout: 30_000,
      });

      // The board's real listener, on the app origin so the session rides along.
      await page.evaluate(async (slug) => {
        const received: PrsWatchEvent[] = [];
        window.__prsEvents = received;
        const es = new EventSource(
          `/api/${encodeURIComponent(slug)}/watch?types=task-board.item.prs.updated`,
        );
        es.addEventListener("task-board.item.prs.updated", (e) => {
          received.push(JSON.parse((e as MessageEvent).data) as PrsWatchEvent);
        });
        if (es.readyState === EventSource.OPEN) return;
        await new Promise<void>((resolve, reject) => {
          es.onopen = () => resolve();
          es.onerror = () => reject(new Error("watch stream failed to open"));
        });
      }, orgSlug);

      // CI finishes on GitHub's side, then GitHub tells us about it.
      state.ciDone = true;
      const res = await postWebhook(request, "check_suite", {
        action: "completed",
        repository: { name: repoName, owner: { login: repoOwner } },
        check_suite: {
          status: "completed",
          conclusion: "success",
          pull_requests: [{ number: prNumber }],
        },
      });
      expect(res.status()).toBe(200);
      // The delivery did the work synchronously — GitHub's delivery log is the
      // only debugging surface this path has, so it must report it.
      expect(await res.json()).toMatchObject({ ok: true, refreshed: 1 });

      // 1. It reached the browser as an event, with the fresh cards inline.
      await expect
        .poll(() => page.evaluate(() => window.__prsEvents ?? []), {
          timeout: 15_000,
        })
        .toEqual([
          expect.objectContaining({
            subject: item.id,
            data: expect.objectContaining({
              id: item.id,
              prs: [
                expect.objectContaining({
                  number: prNumber,
                  checksStatus: "passing",
                  previewUrl,
                }),
              ],
            }),
          }),
        ]);

      // 2. It was written to the card cache, so a fresh reader sees it too —
      //    no second GitHub round-trip needed to observe the change.
      const { prs } = await call<{ prs: TaskBoardItemPr[] }>(
        "TASK_BOARD_ITEM_PRS_GET",
        { taskBoardItemId: item.id },
      );
      expect(prs[0]).toMatchObject({ checksStatus: "passing", previewUrl });

      // 3. The already-open dialog repainted from the push: green checks, and a
      //    preview control for the url. The probe can't reach a fake
      //    `*.deco.site` from CI, so the control renders in its unavailable
      //    form — either label proves `previewUrl` reached the UI.
      await expect(page.getByText("Checks passing")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByRole("button", { name: /Open preview|Preview unavailable/ }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await github.stop();
    }
  });

  test("an issue_comment on a PR refreshes it; one on a plain issue does not", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;

    const repoOwner = "acme-e2e";
    const repoName = `commented-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const prNumber = 77;
    const prUrl = `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`;
    const previewUrl = `https://${repoName}.deco.site`;

    const state = { ciDone: true };
    const github = await startGithubMcp(state, previewUrl);
    try {
      await createGithubConnection(request, orgSlug, github.url);
      const { item } = await callSelfMcpTool<{ item: TaskBoardItem }>(
        request,
        orgSlug,
        "TASK_BOARD_ITEM_CREATE",
        { title: "Commented card", status: "in_review", prUrl },
      );
      expect(item.id).toBeTruthy();

      const repository = { name: repoName, owner: { login: repoOwner } };
      const onPr = await postWebhook(request, "issue_comment", {
        action: "created",
        repository,
        issue: { number: prNumber, pull_request: { url: "https://api/x" } },
      });
      expect(await onPr.json()).toMatchObject({ ok: true, refreshed: 1 });

      // No `pull_request` key: a comment on a plain issue names no PR, so the
      // reverse lookup must not run on the issue number as if it were one.
      const onIssue = await postWebhook(request, "issue_comment", {
        action: "created",
        repository,
        issue: { number: prNumber },
      });
      expect(await onIssue.json()).toMatchObject({
        ok: true,
        ignored: "shape",
      });
    } finally {
      await github.stop();
    }
  });

  test("rejects a bad signature, ignores unhandled events and unlinked PRs", async ({
    authedPage,
  }) => {
    const request = authedPage.page.context().request;
    const repository = {
      name: "nobody-links-me",
      owner: { login: "acme-e2e" },
    };

    // The route's only authentication is the HMAC — a wrong one is a 400, and
    // must not be treated as an unsigned-but-harmless ping.
    const forged = await postWebhook(
      request,
      "check_suite",
      { repository },
      "sha256=" + "0".repeat(64),
    );
    expect(forged.status()).toBe(400);

    // An event nobody consumes is a 200: GitHub retries non-2xx, and there is
    // nothing here to retry.
    const unhandled = await postWebhook(request, "star", { repository });
    expect(unhandled.status()).toBe(200);
    expect(await unhandled.json()).toMatchObject({ ignored: "event" });

    // A real event for a repo no card links: the indexed lookup finds nothing
    // and the delivery still succeeds. This is the common case in prod, where
    // the App is installed on far more repos than the board tracks.
    const unlinked = await postWebhook(request, "check_suite", {
      action: "completed",
      repository,
      check_suite: { pull_requests: [{ number: 1 }] },
    });
    expect(await unlinked.json()).toMatchObject({ ok: true, refreshed: 0 });
  });
});
