/**
 * E2E: the "Request received / accepted and queued" spinner must not outlive a
 * persisted answer.
 *
 * Reproduces the production hang (viktor@decocms.com, "always"): the chat UI
 * sticks on the run-status spinner "Request received — The run was accepted and
 * queued" forever even though the run completed server-side and the answer is
 * persisted. The root cause is stream-delivery, not the backend: a fast run's
 * live `/stream` tail can deliver 0 chunks (the JetStream subject is purged on
 * terminal status before this client's consumer reads it), so no `finish` chunk
 * ever clears the client's `runStatusStage` / `submitted` status.
 *
 * Black-box reproduction (HTTP + DB only, no app imports):
 *   1. Drive the real browser: open an (empty, v2) thread and send a message.
 *      POST /messages is intercepted → 202 so NO real run dispatches — the
 *      client enters exactly the post-202 "Request received" spinner state, and
 *      the live tail stays silent (there are no chunks to deliver), matching the
 *      0-chunks race.
 *   2. Assert the stuck spinner is showing.
 *   3. Seed the persisted reply directly into `thread_message_parts` (+ flip the
 *      thread terminal), simulating the run that already completed server-side.
 *   4. Assert the reply renders AND the spinner clears — WITHOUT a page reload.
 *      The fix's client-side DB reconcile (refetch self-clear + post-POST poll)
 *      is the only thing that can surface the answer here.
 *
 * The precise reconcile logic is unit-covered in thread-connection.test.ts; this
 * is the black-box contract guard for the user-visible behavior.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { connectDevDb } from "../fixtures/db";
import { expect, test } from "../fixtures/test";

const CHAT_INPUT = '[data-chat-input="true"]';
// Cold-Vite first paint on a fresh sandbox can take 20-40s.
const CHAT_INPUT_TIMEOUT_MS = 60_000;
// The run-status spinner's title (apps/.../run-status.ts RUN_STATUS_COPY) — the
// "received" stage the client enters after the POST 202 and the reported hang.
const STUCK_SPINNER_TEXT = "Request received";

type Db = Awaited<ReturnType<typeof connectDevDb>>;

async function orgIdForSlug(db: Db, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no organization row for slug ${slug}`);
  return id;
}

/** Seed an AI provider key so the route renders the composer, not the
 *  NoAiProviderEmptyState. The key is never exercised (POST is intercepted). */
async function seedAiProviderKey(
  request: APIRequestContext,
  orgSlug: string,
): Promise<void> {
  await callSelfMcpTool(request, orgSlug, "AI_PROVIDER_KEY_CREATE", {
    providerId: "anthropic",
    label: "spinner-reconcile-e2e",
    apiKey: "sk-ant-e2e-fake-key-do-not-use",
  });
}

/** Create an agent (virtual MCP) + a v2 thread (so the read path folds the
 *  seeded `thread_message_parts`). Returns the thread id. */
async function createV2Thread(
  api: APIRequestContext,
  db: Db,
  orgSlug: string,
  orgId: string,
): Promise<string> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Spinner-reconcile E2E Agent",
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: agent.item.id, title: "Spinner-reconcile" } },
  );
  const threadId = thread.item.id;
  await db.query(
    `UPDATE threads SET message_storage_version = 2 WHERE id = $1 AND organization_id = $2`,
    [threadId, orgId],
  );
  return threadId;
}

/** Persist a finished assistant message (text + finish anchor) for the thread,
 *  exactly as the durable projector would, and flip the thread terminal — the
 *  "run already completed server-side" state. */
async function seedPersistedReply(
  db: Db,
  orgId: string,
  threadId: string,
  text: string,
): Promise<void> {
  const runId = `run_reconcile_e2e_${Date.now()}`;
  const messageId = `msg_reconcile_e2e_${Date.now()}`;
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO thread_message_parts
       (id, seq, org_id, thread_id, run_id, message_id, role, kind, payload, created_at)
     VALUES
       ($1, 0, $2, $3, $4, $5, 'assistant', 'text', $6, $7),
       ($8, 1, $2, $3, $4, $5, 'assistant', 'finish', $9, $7)`,
    [
      `${runId}:0`,
      orgId,
      threadId,
      runId,
      messageId,
      JSON.stringify({ type: "text", text }),
      now,
      `${runId}:1`,
      JSON.stringify({}),
    ],
  );
  await db.query(
    `UPDATE threads SET status = 'completed', updated_at = $2 WHERE id = $1`,
    [threadId, now],
  );
}

async function waitForChatInput(page: Page): Promise<void> {
  await page
    .locator(CHAT_INPUT)
    .waitFor({ state: "visible", timeout: CHAT_INPUT_TIMEOUT_MS });
}

/** Tiptap is contenteditable — type via real keystrokes, then wait for render. */
async function typeInComposer(page: Page, text: string): Promise<void> {
  const input = page.locator(CHAT_INPUT);
  await input.click();
  await page.keyboard.type(text);
  await expect(input).toHaveText(text, { timeout: 15_000 });
}

/** Dismiss the bottom-right release-announcement popover if present — it sits on
 *  the send button's z-index and intercepts the click. No-op if absent. */
async function dismissReleaseAnnouncement(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Release announcement" });
  if ((await dialog.count()) === 0) return;
  const closeButton = dialog.getByRole("button").first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click().catch(() => {});
  } else {
    await page.keyboard.press("Escape");
  }
  await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
}

async function submitComposer(page: Page): Promise<void> {
  await dismissReleaseAnnouncement(page);
  await page
    .getByTitle("Send message (Enter)", { exact: true })
    .first()
    .click();
}

test.describe("decopilot run-status spinner reconcile", () => {
  // Cold Vite + signUp + navigation easily exceeds the 30s default.
  test.setTimeout(180_000);

  // Pre-mark releases seen so the FloatingReleaseCard popover never intercepts
  // the send button (mirrors chat-input-draft.spec.ts).
  test.beforeEach(async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await seedAiProviderKey(page.context().request, orgSlug);
    await page.addInitScript(() => {
      // Mark every known release seen so the FloatingReleaseCard popover never
      // renders. Keep in lockstep with apps/mesh/src/web/lib/release-feed.ts;
      // submitComposer also dismisses the dialog at runtime as a fallback.
      const seenAt = "1970-01-01T00:00:00.000Z";
      const ids = [
        "fable-5-suspension",
        "claude-fable-5",
        "claude-opus-4-8",
        "enhanced-sidebar",
        "smarter-task-delegation",
        "sidebar-task-groups",
        "release-channel",
      ];
      try {
        localStorage.setItem(
          "studio.release-feed.v1",
          JSON.stringify(Object.fromEntries(ids.map((id) => [id, { seenAt }]))),
        );
      } catch {
        // private mode — ignore
      }
    });
  });

  test("a fast turn's spinner clears once the answer persists, without a reload", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const threadId = await createV2Thread(api, db, orgSlug, orgId);

      // Accept the send WITHOUT dispatching a real run: the client enters the
      // post-202 "Request received" spinner state and the live /stream tail has
      // nothing to deliver — exactly the 0-chunks race.
      await page.route("**/decopilot/threads/*/messages", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ taskId: threadId }),
        });
      });

      await page.goto(`/${orgSlug}/${threadId}`);
      await waitForChatInput(page);

      await typeInComposer(page, "hello reconcile");
      await submitComposer(page);

      // The reported symptom: the run-status spinner is up after the 202.
      await expect(page.getByText(STUCK_SPINNER_TEXT)).toBeVisible({
        timeout: 30_000,
      });

      // The run "completed" server-side: persist the reply + flip the thread
      // terminal. The live tail still delivers nothing.
      const replyMarker = `reconciled-reply-${Date.now()}`;
      await seedPersistedReply(db, orgId, threadId, replyMarker);

      // The fix's DB reconcile surfaces the persisted reply and clears the
      // spinner — without any page reload.
      await expect(page.getByText(replyMarker)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(STUCK_SPINNER_TEXT)).toBeHidden();
    } finally {
      await db.end();
    }
  });
});
