import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";

// Run against a test deployment configured with an existing admin org and project.
const targetOrg = process.env.STUDIO_FEEDBACK_ORG_ID;
const targetProject = process.env.STUDIO_FEEDBACK_PROJECT_ID;

test("feedback stores private files and copies them into the configured board", async ({
  authedPage,
}) => {
  test.skip(
    !targetOrg || !targetProject,
    "Requires configured feedback destination",
  );
  const { page, orgSlug } = authedPage;
  const message = `Feedback test ${crypto.randomUUID()}`;
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=",
    "base64",
  );
  const response = await page.request.post(`/api/${orgSlug}/feedback`, {
    multipart: {
      message,
      pageUrl: "https://example.com/chat?token=secret#private",
      screenshot: {
        name: "screenshot.png",
        mimeType: "image/png",
        buffer: bytes,
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const db = await connectDevDb();
  try {
    const result = await db.query(
      "SELECT id, created_by, description, virtual_mcp_id FROM task_board_items WHERE organization_id = $1 AND title = $2",
      [targetOrg, `Feedback: ${message}`],
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.virtual_mcp_id).toBe(targetProject);
    expect(row.created_by).toBe("system");
    expect(row.description).toContain("Sender name: ");
    const tags = await db.query(
      "SELECT t.name FROM organization_tags t JOIN task_board_item_tags link ON link.id = t.id WHERE link.task_board_item_id = $1",
      [row.id],
    );
    expect(tags.rows.map((tag) => tag.name)).toContain("feedback button");
    expect(row.description).not.toContain("base64");
    expect(row.description).not.toContain("token=secret");
    const match = row.description.match(/!\[Screenshot 1\]\(([^)]+)\)/);
    expect(match).not.toBeNull();
    // The sender is not a member of the destination org.
    expect((await page.request.get(match[1])).ok()).toBe(false);
    const path = new URL(match[1], "http://localhost").searchParams.get("path");
    const userId = row.description.match(/Sender: ([^\n]+)/)[1];
    const personal = await page.request.get(
      `/api/_users/fs/${encodeURIComponent(userId)}/read?path=${encodeURIComponent(`feedback/${path}`)}`,
    );
    expect(personal.ok()).toBe(true);
    expect(await personal.body()).toEqual(bytes);
  } finally {
    await db.end();
  }
});
