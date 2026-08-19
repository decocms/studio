/**
 * E2E: the org's task-run env list round-trips through real Postgres.
 *
 * Black-box over the self MCP. The three storage rules an in-memory fake can't
 * prove: the jsonb column persists what was written, a partial update of a
 * DIFFERENT settings field doesn't wipe it (`undefined` skips the column), and
 * `[]` really clears it rather than being swallowed as falsy — which is the only
 * way a member removes the last variable.
 */

import { signUp } from "../fixtures/auth";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  expect,
  extractOrgSlugFromUrl,
  test,
  waitForPostSignupRedirect,
} from "../fixtures/test";

interface OrgSettings {
  organizationId: string;
  task_board_env?: { key: string; secretId: string }[] | null;
  flags?: { reports_only?: boolean } | null;
}

async function lookupOrgId(orgSlug: string): Promise<string> {
  const db = await connectDevDb();
  try {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [orgSlug],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`organization not found for slug: ${orgSlug}`);
    return id;
  } finally {
    await db.end();
  }
}

test.describe("Organization task-run environment", () => {
  test("sets, preserves across partial updates, and clears task_board_env", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    const orgId = await lookupOrgId(orgSlug);
    const request = page.context().request;

    const secret = await callSelfMcpTool<{ id: string }>(
      request,
      orgSlug,
      "SECRET_CREATE",
      {
        scope: "organization",
        name: "TASK_ENV_E2E",
        value: "not-a-real-token",
      },
    );

    const set = await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_UPDATE",
      {
        organizationId: orgId,
        task_board_env: [{ key: "SOME_API_KEY", secretId: secret.id }],
      },
    );
    expect(set.task_board_env).toEqual([
      { key: "SOME_API_KEY", secretId: secret.id },
    ]);

    // A partial update of another field must not wipe the list.
    await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { reports_only: true },
    });
    const afterPartial = await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    expect(afterPartial.task_board_env).toEqual([
      { key: "SOME_API_KEY", secretId: secret.id },
    ]);

    // Removing the last variable writes `[]`, which must persist as empty.
    await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      task_board_env: [],
    });
    const afterClear = await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    expect(afterClear.task_board_env ?? []).toEqual([]);
    expect(afterClear.flags?.reports_only).toBe(true);
  });

  test("rejects an env key that isn't a valid variable name", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    const orgId = await lookupOrgId(orgSlug);
    const request = page.context().request;

    await expect(
      callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
        organizationId: orgId,
        task_board_env: [{ key: "not a key", secretId: "sec_whatever" }],
      }),
    ).rejects.toThrow();
  });
});
