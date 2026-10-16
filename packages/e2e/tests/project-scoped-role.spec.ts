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

type ApiContext = Awaited<ReturnType<typeof newApiContext>>;

/** A fresh member of `orgId`, signed in, on one new custom role per `permissions` entry. */
async function memberOnCustomRoles(
  playwright: Parameters<typeof newApiContext>[0],
  db: Client,
  ownerCtx: ApiContext,
  orgId: string,
  permissions: Record<string, string[]>[],
): Promise<ApiContext> {
  const roleSlugs: string[] = [];
  for (const permission of permissions) {
    const roleSlug = `scoped-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const createRole = await ownerCtx.post(
      "/api/auth/organization/create-role",
      { data: { organizationId: orgId, role: roleSlug, permission } },
    );
    expect(
      createRole.ok(),
      `create-role failed: ${await createRole.text().catch(() => "")}`,
    ).toBe(true);
    roleSlugs.push(roleSlug);
  }

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
    { data: { organizationId: orgId, memberId, role: roleSlugs } },
  );
  expect(
    assign.ok(),
    `update-member-role failed: ${await assign.text().catch(() => "")}`,
  ).toBe(true);
  return memberCtx;
}

async function createProject(
  ctx: ApiContext,
  orgSlug: string,
  title: string,
): Promise<string> {
  const res = await ctx.post(
    `/api/${orgSlug}/tools/COLLECTION_VIRTUAL_MCP_CREATE`,
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

    const projectAId = await createProject(
      ownerCtx,
      owner.orgSlug,
      `Project A ${Date.now()}`,
    );
    const projectBId = await createProject(
      ownerCtx,
      owner.orgSlug,
      `Project B ${Date.now()}`,
    );

    // A member on a custom role scoped to project A only.
    const memberCtx = await memberOnCustomRoles(
      playwright,
      db,
      ownerCtx,
      orgId,
      [{ [PROJECT_SCOPE_KEY]: [projectAId] }],
    );

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

  test("a role that hides one project keeps it and its cards off the board", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgId = await orgIdForSlug(db, owner.orgSlug);

    const openId = await createProject(
      ownerCtx,
      owner.orgSlug,
      `Open ${Date.now()}`,
    );
    const hiddenId = await createProject(
      ownerCtx,
      owner.orgSlug,
      `Hidden ${Date.now()}`,
    );
    const createCard = async (title: string, virtualMcpId?: string) => {
      const res = await ownerCtx.post(
        `/api/${owner.orgSlug}/tools/TASK_BOARD_ITEM_CREATE`,
        { data: { title, ...(virtualMcpId ? { virtualMcpId } : {}) } },
      );
      expect(res.ok(), `create card ${title}: ${await res.text()}`).toBe(true);
      const body = (await res.json()) as { item: { id: string } };
      return body.item.id;
    };
    const openCard = await createCard("open card", openId);
    const hiddenCard = await createCard("hidden card", hiddenId);
    const unfiledCard = await createCard("unfiled card");
    // Older clients wrote the project id into `repo` and left the stamp empty.
    const legacyCard = await createCard("legacy card");
    await db.query(`UPDATE task_board_items SET repo = $1 WHERE id = $2`, [
      hiddenId,
      legacyCard,
    ]);

    // Every project but one, plus a gated tool, so the role's statement is
    // what decides — not the basic-usage floor every member gets.
    const memberCtx = await memberOnCustomRoles(
      playwright,
      db,
      ownerCtx,
      orgId,
      [
        {
          [PROJECT_SCOPE_KEY]: ["*", `!${hiddenId}`],
          self: ["COLLECTION_VIRTUAL_MCP_CREATE"],
        },
      ],
    );

    const list = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_LIST`,
      { data: {} },
    );
    expect(list.ok()).toBe(true);
    const projectIds = (
      (await list.json()) as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(projectIds).toContain(openId);
    expect(projectIds).not.toContain(hiddenId);

    const board = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/TASK_BOARD_ITEM_LIST`,
      { data: {} },
    );
    expect(board.ok(), `member board: HTTP ${board.status()}`).toBe(true);
    const cardIds = (
      (await board.json()) as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(cardIds).toContain(openCard);
    expect(cardIds).toContain(unfiledCard);
    expect(cardIds).not.toContain(hiddenCard);
    expect(cardIds).not.toContain(legacyCard);

    // A hidden card reads as missing through the tools that take its id.
    const call = (tool: string, data: Record<string, unknown>) =>
      memberCtx.post(`/api/${owner.orgSlug}/tools/${tool}`, { data });
    for (const id of [hiddenCard, legacyCard]) {
      for (const [tool, data] of [
        ["TASK_BOARD_COMMENT_LIST", { taskBoardItemId: id }],
        ["TASK_BOARD_ACTIVITY_LIST", { taskBoardItemId: id }],
        ["TASK_BOARD_ITEM_UPDATE", { id, title: "renamed" }],
      ] as const) {
        const res = await call(tool, data);
        expect(res.ok(), `${tool} on a hidden card`).toBe(false);
        expect(await res.text()).toContain("not found");
      }
    }
    const visibleComments = await call("TASK_BOARD_COMMENT_LIST", {
      taskBoardItemId: openCard,
    });
    expect(visibleComments.ok()).toBe(true);

    const search = await call("GLOBAL_SEARCH", {
      query: "card",
      types: ["task"],
    });
    expect(search.ok(), `member search: HTTP ${search.status()}`).toBe(true);
    const foundIds = (
      (await search.json()) as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(foundIds).toContain(openCard);
    expect(foundIds).not.toContain(hiddenCard);
    expect(foundIds).not.toContain(legacyCard);

    // Projects created after the role still reach it.
    const laterId = await createProject(
      memberCtx,
      owner.orgSlug,
      `Later ${Date.now()}`,
    );
    const later = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_GET`,
      { data: { id: laterId } },
    );
    expect(
      ((await later.json()) as { item?: { id?: string } | null }).item?.id,
    ).toBe(laterId);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });

  test("a member with two scoped roles sees the projects of both", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgId = await orgIdForSlug(db, owner.orgSlug);

    const aId = await createProject(ownerCtx, owner.orgSlug, `A ${Date.now()}`);
    const bId = await createProject(ownerCtx, owner.orgSlug, `B ${Date.now()}`);
    const cId = await createProject(ownerCtx, owner.orgSlug, `C ${Date.now()}`);
    const cCard = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/TASK_BOARD_ITEM_CREATE`,
      { data: { title: "c card", virtualMcpId: cId } },
    );
    expect(cCard.ok(), `create card: ${await cCard.text()}`).toBe(true);
    const cCardId = ((await cCard.json()) as { item: { id: string } }).item.id;

    const memberCtx = await memberOnCustomRoles(
      playwright,
      db,
      ownerCtx,
      orgId,
      [{ [PROJECT_SCOPE_KEY]: [aId] }, { [PROJECT_SCOPE_KEY]: [bId] }],
    );

    const list = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_LIST`,
      { data: {} },
    );
    expect(list.ok()).toBe(true);
    const projectIds = (
      (await list.json()) as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(projectIds).toContain(aId);
    expect(projectIds).toContain(bId);
    expect(projectIds).not.toContain(cId);

    const board = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/TASK_BOARD_ITEM_LIST`,
      { data: {} },
    );
    expect(board.ok(), `member board: HTTP ${board.status()}`).toBe(true);
    const cardIds = (
      (await board.json()) as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(cardIds).not.toContain(cCardId);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });
});
