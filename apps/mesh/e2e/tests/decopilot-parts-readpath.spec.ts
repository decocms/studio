/**
 * E2E: v2 read path — `COLLECTION_THREAD_MESSAGES_LIST` folds
 * `thread_message_parts`.
 *
 * Task 7 of the stream-of-record plan forks the thread-history readers (the
 * `COLLECTION_THREAD_MESSAGES_LIST` tool + `Memory.loadHistory`): when a
 * thread's `message_storage_version === 2`, history is folded from the
 * append-only `thread_message_parts` stream-of-record instead of the legacy
 * `thread_messages` rows. The org-scoped thread fetch (R23) is preserved — the
 * thread is loaded org-scoped first, so the id handed to the part storage
 * always belongs to the bound org.
 *
 * Like the sibling decopilot specs, this exercises the real HTTP/MCP front door
 * (`callSelfMcpTool`) rather than rendering the chat UI: rendering a transcript
 * needs model/credential onboarding the read-path fork is orthogonal to, so the
 * list tool — the actual code under test — is the honest, robust surface.
 *
 * Seeds, via `connectDevDb()`:
 *   - a v2 thread (`message_storage_version = 2`) owned by the authed user/org
 *   - one finished assistant message expressed as TWO parts: a `text` part
 *     (payload = the UI text part) + a `finish` anchor (payload = {}).
 *     `foldParts` folds these into `parts: [{ type: "text", text }]`, complete.
 *
 * It then calls the list tool and asserts the folded message comes back.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

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
  test("COLLECTION_THREAD_MESSAGES_LIST folds parts for a v2 thread", async ({
    authedPage,
  }) => {
    const { page, user, orgSlug } = authedPage;
    const api = page.context().request;
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

      // The UI's history reader, through the real MCP front door. For a v2
      // thread this folds thread_message_parts (our Task-7 fork); for v1 it
      // would read the frozen thread_messages table.
      const result = await callSelfMcpTool<{
        items: Array<{ id: string; role: string; parts: unknown[] }>;
        totalCount: number;
      }>(api, orgSlug, "COLLECTION_THREAD_MESSAGES_LIST", {
        thread_id: threadId,
      });

      expect(result.totalCount).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.role).toBe("assistant");
      // foldParts drops the `finish` anchor and folds the text part back into
      // the message `parts` array.
      expect(JSON.stringify(result.items[0]!.parts)).toContain(SEED_TEXT);
    } finally {
      await db.end();
    }
  });
});
