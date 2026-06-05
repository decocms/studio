/**
 * E2E: v2 read path folds `thread_message_parts` into thread history.
 *
 * Task 7 of the stream-of-record plan forks `Memory.loadHistory`: when a
 * thread's `message_storage_version === 2`, history is folded from the
 * `thread_message_parts` stream-of-record instead of the legacy
 * `thread_messages` rows. The org-scoped thread fetch (R23) is preserved —
 * the thread is loaded org-scoped first, so the id handed to the part storage
 * always belongs to the bound org.
 *
 * This spec seeds, directly via `connectDevDb()`:
 *   - a v2 thread (message_storage_version = 2) owned by the authed user/org
 *   - one finished assistant message expressed as TWO parts: a `text` part
 *     (payload = the UI text part) + a `finish` part (payload = {}). This is
 *     the same shape `foldParts` expects (see thread-message-parts.integration
 *     test C1), which folds to `parts: [{ type: "text", text }]`.
 *
 * It then opens the thread in the browser and asserts the seeded assistant
 * text is present in the rendered transcript.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";

const SEED_TEXT = "stream-of-record fold marker 8f3a";

/** Resolve the org id (not slug) the threads FK + part rows need. */
async function orgIdForSlug(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  slug: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no organization row for slug ${slug}`);
  return id;
}

test.describe("v2 read path — folds thread_message_parts", () => {
  // Cold Vite + signup + chat bootstrap can exceed the 30s default.
  test.setTimeout(180_000);

  test("a v2 thread renders an assistant message folded from parts", async ({
    authedPage,
  }) => {
    const { page, user, orgSlug } = authedPage;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const threadId = `thrd_parts_e2e_${Date.now()}`;
      const messageId = `msg_parts_e2e_${Date.now()}`;
      const runId = `run_parts_e2e_${Date.now()}`;
      const now = new Date().toISOString();

      // v2 thread. NOT NULL columns the schema requires: virtual_mcp_id,
      // status, message_storage_version. created_by/organization_id satisfy
      // the org/user FKs that `authedPage` already created.
      await db.query(
        `INSERT INTO threads
           (id, organization_id, title, status, virtual_mcp_id,
            message_storage_version, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, 'completed', '', 2, $4, $4, $5)`,
        [threadId, orgId, "Parts read-path thread", now, user.userId],
      );

      // One finished assistant message expressed as two parts: a `text` part
      // (payload = the UI text part object) and a `finish` anchor (payload {}).
      // foldParts → parts: [{ type: "text", text: SEED_TEXT }], status complete.
      await db.query(
        `INSERT INTO thread_message_parts
           (id, seq, org_id, thread_id, run_id, message_id, role, kind,
            payload, created_at)
         VALUES
           ($1, 0, $2, $3, $4, $5, 'assistant', 'text', $6, $7),
           ($8, 1, $2, $3, $4, $5, 'assistant', 'finish', $9, $7)`,
        [
          `${runId}:0`,
          orgId,
          threadId,
          runId,
          messageId,
          JSON.stringify({ type: "text", text: SEED_TEXT }),
          now,
          `${runId}:1`,
          JSON.stringify({}),
        ],
      );

      // Open the thread. The transcript should contain the folded text.
      await page.goto(`/${orgSlug}/${threadId}`);
      await expect(page.getByText(SEED_TEXT, { exact: false })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await db.end();
    }
  });
});
