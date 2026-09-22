/**
 * E2E: a project-scoped custom role only sees/acts on its allowlisted projects.
 *
 * A custom role carries a project allowlist under the reserved `projects` key in
 * its permission map (the wire contract — inlined here on purpose, black-box).
 * A member on such a role must:
 *   - list only the allowlisted projects (COLLECTION_VIRTUAL_MCP_LIST),
 *   - get an allowlisted project, but
 *   - get null (not-found, no existence leak) for a project outside the list.
 *
 * Projects are pinned/unpinned VIRTUAL connections; both LIST and GET are
 * basic-usage, so the member reaches the handler regardless of role — the
 * narrowing happens in the handler, which is what this guards.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

// Reserved permission-map key holding a role's project allowlist (wire contract).
const PROJECT_SCOPE_KEY = "projects";

async function orgIdForSlug(db: Client, slug: string): Promise<string> {
  const row = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error(`org not found for slug ${slug}`);
  return id;
}

test.describe("project-scoped role", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("a member scoped to one project cannot see or read the other", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgId = await orgIdForSlug(db, owner.orgSlug);

    const createProject = async (title: string): Promise<string> => {
      const res = await ownerCtx.post(
        `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_CREATE`,
        { data: { data: { title, connections: [] } } },
      );
      expect(
        res.ok(),
        `create ${title} failed: HTTP ${res.status()} — ${await res
          .text()
          .catch(() => "")}`,
      ).toBe(true);
      const body = (await res.json()) as { item?: { id?: string } };
      const id = body.item?.id;
      if (!id) throw new Error(`no id returned creating ${title}`);
      return id;
    };

    const projectAId = await createProject(`Project A ${Date.now()}`);
    const projectBId = await createProject(`Project B ${Date.now()}`);

    // Custom role scoped to project A only.
    const roleSlug = `scoped-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const createRole = await ownerCtx.post(
      "/api/auth/organization/create-role",
      {
        data: {
          organizationId: orgId,
          role: roleSlug,
          permission: { [PROJECT_SCOPE_KEY]: [projectAId] },
        },
      },
    );
    expect(
      createRole.ok(),
      `create-role failed: ${await createRole.text().catch(() => "")}`,
    ).toBe(true);

    // A member, invited then assigned the scoped role.
    const memberCtx = await newApiContext(playwright);
    const member = await signUpViaApi(memberCtx);
    const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
      data: { organizationId: orgId, email: member.email, role: "user" },
    });
    expect(invite.ok()).toBe(true);
    const inviteJson = (await invite.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const invitationId = inviteJson.id ?? inviteJson.invitation?.id;
    const accept = await memberCtx.post(
      "/api/auth/organization/accept-invitation",
      { data: { invitationId } },
    );
    expect(accept.ok()).toBe(true);

    const memberRow = await db.query<{ id: string }>(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [member.userId, orgId],
    );
    const memberId = memberRow.rows[0]?.id;
    if (!memberId) throw new Error("member row not found after accept");
    const assign = await ownerCtx.post(
      "/api/auth/organization/update-member-role",
      { data: { organizationId: orgId, memberId, role: [roleSlug] } },
    );
    expect(
      assign.ok(),
      `update-member-role failed: ${await assign.text().catch(() => "")}`,
    ).toBe(true);

    // LIST returns only the allowlisted project.
    const list = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_LIST`,
      { data: {} },
    );
    expect(list.ok(), `member LIST: HTTP ${list.status()}`).toBe(true);
    const listBody = (await list.json()) as { items?: Array<{ id: string }> };
    const ids = (listBody.items ?? []).map((i) => i.id);
    expect(ids).toContain(projectAId);
    expect(ids).not.toContain(projectBId);

    // GET on the allowlisted project returns it.
    const getA = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_GET`,
      { data: { id: projectAId } },
    );
    expect(getA.ok()).toBe(true);
    const getABody = (await getA.json()) as { item?: { id?: string } | null };
    expect(getABody.item?.id).toBe(projectAId);

    // GET on the out-of-scope project is a null not-found (no existence leak).
    const getB = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_GET`,
      { data: { id: projectBId } },
    );
    expect(getB.ok()).toBe(true);
    const getBBody = (await getB.json()) as { item?: { id?: string } | null };
    expect(getBBody.item ?? null).toBeNull();

    // A mutation on the out-of-scope project must be rejected too, not just LIST/GET.
    const pinB = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/VIRTUAL_MCP_PINNED_VIEWS_UPDATE`,
      { data: { virtualMcpId: projectBId, pinnedViews: [] } },
    );
    expect(pinB.ok(), "member must not mutate an out-of-scope project").toBe(
      false,
    );

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });
});
