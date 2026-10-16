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
import { expect, getE2EAppOrigin, newApiContext, test } from "../fixtures/test";

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

/** A fresh user, signed in, who accepted an invite to `orgId` as `role`. */
async function joinOrg(
  playwright: Parameters<typeof newApiContext>[0],
  db: Client,
  ownerCtx: ApiContext,
  orgId: string,
  role: "user" | "admin",
): Promise<{ memberCtx: ApiContext; memberId: string }> {
  const memberCtx = await newApiContext(playwright);
  const member = await signUpViaApi(memberCtx);
  const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
    data: { organizationId: orgId, email: member.email, role },
  });
  expect(invite.ok()).toBe(true);
  const inviteJson = (await invite.json()) as {
    id?: string;
    invitation?: { id?: string };
  };
  const invitationId = inviteJson.id ?? inviteJson.invitation?.id;
  const accept = await memberCtx.post(
    "/api/auth/organization/accept-invitation",
    {
      data: { invitationId },
    },
  );
  expect(accept.ok()).toBe(true);

  const memberRow = await db.query<{ id: string }>(
    `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
    [member.userId, orgId],
  );
  const memberId = memberRow.rows[0]?.id;
  if (!memberId) throw new Error("member row not found after accept");
  return { memberCtx, memberId };
}

interface BoardEvent {
  type: string;
  subject: string;
  data: { id: string; title?: string };
}

const BOARD_EVENT_TYPES = [
  "task-board.item.updated",
  "task-board.item.deleted",
  "task-board.item.prs.updated",
];

/** The board's `/watch` stream as `ctx` sees it, collected until `close()`. */
async function watchBoard(ctx: ApiContext, orgSlug: string) {
  const origin = getE2EAppOrigin();
  const { cookies } = await ctx.storageState();
  const controller = new AbortController();
  const res = await fetch(
    `${origin}/api/${encodeURIComponent(orgSlug)}/watch?types=${BOARD_EVENT_TYPES.join(",")}`,
    {
      headers: {
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        origin,
      },
      signal: controller.signal,
    },
  );
  expect(res.ok, `watch: HTTP ${res.status}`).toBe(true);
  const body = res.body;
  if (!body) throw new Error("watch stream has no body");

  const events: BoardEvent[] = [];
  let onConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    onConnected = resolve;
  });
  void (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: ?(.*)$/m.exec(block)?.[1];
          const data = /^data: ?(.*)$/m.exec(block)?.[1];
          if (name === "connected") onConnected();
          else if (name && data) {
            const parsed = JSON.parse(data) as Omit<BoardEvent, "type">;
            events.push({ ...parsed, type: name });
          }
          end = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  await connected;
  return { events, close: () => controller.abort() };
}

/** A tool response with ids blanked, so two callers' outcomes compare. */
async function outcome(res: Awaited<ReturnType<ApiContext["post"]>>) {
  const text = (await res.text()).replace(
    /\b[a-z]+_[A-Za-z0-9_-]{8,}\b/g,
    "<id>",
  );
  return res.ok() ? "ok" : `HTTP ${res.status()}: ${text}`;
}

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
      {
        data: { organizationId: orgId, role: roleSlug, permission },
      },
    );
    expect(
      createRole.ok(),
      `create-role failed: ${await createRole.text().catch(() => "")}`,
    ).toBe(true);
    roleSlugs.push(roleSlug);
  }

  const { memberCtx, memberId } = await joinOrg(
    playwright,
    db,
    ownerCtx,
    orgId,
    "user",
  );
  const assign = await ownerCtx.post(
    "/api/auth/organization/update-member-role",
    {
      data: { organizationId: orgId, memberId, role: roleSlugs },
    },
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
    {
      data: { data: { title, connections: [] } },
    },
  );
  expect(
    res.ok(),
    `create ${title} failed: HTTP ${res.status()} — ${await res.text().catch(() => "")}`,
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
      {
        data: {},
      },
    );
    expect(list.ok(), `member LIST: HTTP ${list.status()}`).toBe(true);
    const listBody = (await list.json()) as { items?: Array<{ id: string }> };
    const ids = (listBody.items ?? []).map((i) => i.id);
    expect(ids).toContain(projectAId);
    expect(ids).not.toContain(projectBId);

    // GET on the allowlisted project returns it.
    const getA = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_GET`,
      {
        data: { id: projectAId },
      },
    );
    expect(getA.ok()).toBe(true);
    const getABody = (await getA.json()) as { item?: { id?: string } | null };
    expect(getABody.item?.id).toBe(projectAId);

    // GET on the out-of-scope project is a null not-found (no existence leak).
    const getB = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_GET`,
      {
        data: { id: projectBId },
      },
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
        {
          data: { title, ...(virtualMcpId ? { virtualMcpId } : {}) },
        },
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
      {
        data: {},
      },
    );
    expect(list.ok()).toBe(true);
    const projectIds = (
      (await list.json()) as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(projectIds).toContain(openId);
    expect(projectIds).not.toContain(hiddenId);

    const board = await memberCtx.post(
      `/api/${owner.orgSlug}/tools/TASK_BOARD_ITEM_LIST`,
      {
        data: {},
      },
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
      {
        data: { id: laterId },
      },
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
      {
        data: { title: "c card", virtualMcpId: cId },
      },
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
      {
        data: {},
      },
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
      {
        data: {},
      },
    );
    expect(board.ok(), `member board: HTTP ${board.status()}`).toBe(true);
    const cardIds = (
      (await board.json()) as { items: { id: string }[] }
    ).items.map((item) => item.id);
    expect(cardIds).not.toContain(cCardId);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });

  test("a hidden project's cards are missing to every card tool, search and the live stream, and nothing else changes", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgId = await orgIdForSlug(db, owner.orgSlug);
    const slug = owner.orgSlug;

    const openId = await createProject(ownerCtx, slug, `Open ${Date.now()}`);
    const hiddenId = await createProject(
      ownerCtx,
      slug,
      `Hidden ${Date.now()}`,
    );
    const tool = (ctx: ApiContext, name: string, data: unknown) =>
      ctx.post(`/api/${slug}/tools/${name}`, { data });
    const createCard = async (title: string, virtualMcpId?: string) => {
      const res = await tool(ownerCtx, "TASK_BOARD_ITEM_CREATE", {
        title,
        ...(virtualMcpId ? { virtualMcpId } : {}),
      });
      expect(res.ok(), `create card ${title}: ${await res.text()}`).toBe(true);
      return ((await res.json()) as { item: { id: string } }).item.id;
    };
    const threadUnder = async (projectId: string, title: string) => {
      const id = `thrd_e2e_scope_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      await db.query(
        `INSERT INTO threads (id, organization_id, title, status, message_storage_version, created_by, virtual_mcp_id)
         VALUES ($1, $2, $3, 'completed', 2, $4, $5)`,
        [id, orgId, title, owner.userId, projectId],
      );
      return id;
    };
    const linkThread = (cardId: string, threadId: string) =>
      db.query(
        `INSERT INTO task_board_item_threads (task_board_item_id, thread_id, organization_id)
         VALUES ($1, $2, $3)`,
        [cardId, threadId, orgId],
      );
    // The three ways a card reaches a project: its stamp, a project id older
    // clients wrote into `repo`, or a linked thread under the project.
    const hiddenCards = async (label: string) => {
      const stamped = await createCard(`${label} stamped`, hiddenId);
      const legacy = await createCard(`${label} legacy`);
      await db.query(`UPDATE task_board_items SET repo = $1 WHERE id = $2`, [
        hiddenId,
        legacy,
      ]);
      const threaded = await createCard(`${label} threaded`);
      await linkThread(threaded, await threadUnder(hiddenId, `${label} run`));
      return { stamped, legacy, threaded };
    };

    const restricted = await memberOnCustomRoles(
      playwright,
      db,
      ownerCtx,
      orgId,
      [
        {
          [PROJECT_SCOPE_KEY]: ["*", `!${hiddenId}`],
          self: ["*"],
          connections: ["*"],
        },
      ],
    );
    const { memberCtx: admin } = await joinOrg(
      playwright,
      db,
      ownerCtx,
      orgId,
      "admin",
    );

    // Every tool that takes a card (or a comment) id, with the input it needs.
    const commentOn = async (cardId: string) => {
      const res = await tool(ownerCtx, "TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: cardId,
        body: "owner note",
      });
      expect(res.ok(), `comment: ${await res.text()}`).toBe(true);
      return ((await res.json()) as { comment: { id: string } }).comment.id;
    };
    const cardTools: [string, (cardId: string) => Promise<unknown>][] = [
      ["TASK_BOARD_ITEM_UPDATE", async (id) => ({ id, title: "renamed" })],
      ["TASK_BOARD_ITEM_PRS_GET", async (id) => ({ taskBoardItemId: id })],
      ["TASK_BOARD_ITEM_RERUN", async (id) => ({ id })],
      ["TASK_BOARD_RUN_REVIEWER", async (id) => ({ id })],
      ["TASK_BOARD_RESOLVE_CONFLICT", async (id) => ({ id, prNumber: 1 })],
      [
        "TASK_BOARD_REVIEW_DECISION",
        async (id) => ({
          taskBoardItemId: id,
          reviewer: "reviewer",
          decision: "approve",
          notes: "ok",
        }),
      ],
      [
        "TASK_BOARD_PROMOTE_TO_PRODUCTION",
        async (id) => ({ taskBoardItemId: id }),
      ],
      ["TASK_BOARD_ACTIVITY_LIST", async (id) => ({ taskBoardItemId: id })],
      ["TASK_BOARD_COMMENT_LIST", async (id) => ({ taskBoardItemId: id })],
      [
        "TASK_BOARD_COMMENT_CREATE",
        async (id) => ({ taskBoardItemId: id, body: "member note" }),
      ],
      [
        "TASK_BOARD_COMMENT_UPDATE",
        async (id) => ({ id: await commentOn(id), resolved: true }),
      ],
      [
        "TASK_BOARD_COMMENT_DELETE",
        async (id) => ({ id: await commentOn(id) }),
      ],
      [
        "NOTIFICATION_SUBSCRIPTION_SET",
        async (id) => ({ taskBoardItemId: id, subscribed: true }),
      ],
      [
        "NOTIFICATION_SUBSCRIPTION_LIST",
        async (id) => ({ taskBoardItemId: id }),
      ],
      ["TASK_BOARD_ITEM_DELETE", async (id) => ({ id })],
    ];

    for (const [name, input] of cardTools) {
      // Hidden to the role: every attribution reads as a missing card, and
      // nothing is written.
      const hidden = await hiddenCards(name);
      for (const [via, id] of Object.entries(hidden)) {
        const res = await tool(restricted, name, await input(id));
        expect(res.ok(), `${name} on a ${via} hidden card`).toBe(false);
        expect(await res.text(), `${name} on a ${via} hidden card`).toContain(
          `not found`,
        );
      }
      const rows = await db.query<{ title: string; dismissed: boolean }>(
        `SELECT title, dismissed_at IS NOT NULL AS dismissed FROM task_board_items WHERE id = ANY($1)`,
        [Object.values(hidden)],
      );
      expect(rows.rows, `${name} left the hidden cards alone`).toHaveLength(3);
      for (const row of rows.rows) {
        expect(row.title).not.toBe("renamed");
        expect(row.dismissed).toBe(false);
      }
      const written = await db.query(
        `SELECT 1 FROM task_board_comments WHERE task_board_item_id = ANY($1) AND body = 'member note'`,
        [Object.values(hidden)],
      );
      expect(written.rows, `${name} wrote no comment`).toHaveLength(0);

      // Everyone else sees no difference: the restricted member on a visible
      // card, and an admin on a hidden one, get exactly what the owner gets.
      const asOwner = await outcome(
        await tool(
          ownerCtx,
          name,
          await input(await createCard(`${name} a`, openId)),
        ),
      );
      const asRestricted = await outcome(
        await tool(
          restricted,
          name,
          await input(await createCard(`${name} b`, openId)),
        ),
      );
      expect(asRestricted, `${name} on a visible card`).toBe(asOwner);
      const ownerHidden = await outcome(
        await tool(
          ownerCtx,
          name,
          await input(await createCard(`${name} c`, hiddenId)),
        ),
      );
      const adminHidden = await outcome(
        await tool(
          admin,
          name,
          await input(await createCard(`${name} d`, hiddenId)),
        ),
      );
      expect(adminHidden, `${name} as admin on a hidden card`).toBe(
        ownerHidden,
      );
    }

    // Search: a hidden project's threads and cards drop out for the
    // restricted member only.
    const openThread = await threadUnder(openId, "scopesearch open");
    const hiddenThread = await threadUnder(hiddenId, "scopesearch hidden");
    const openSearchCard = await createCard("scopesearch open", openId);
    const hiddenSearch = await hiddenCards("scopesearch");
    const found = async (ctx: ApiContext, query: string) => {
      const res = await tool(ctx, "GLOBAL_SEARCH", { query, limit: 50 });
      expect(res.ok(), `search: ${await res.text()}`).toBe(true);
      return ((await res.json()) as { items: { id: string }[] }).items.map(
        (item) => item.id,
      );
    };
    const everything = [
      openThread,
      hiddenThread,
      openSearchCard,
      ...Object.values(hiddenSearch),
    ];
    for (const ctx of [ownerCtx, admin]) {
      expect(await found(ctx, "scopesearch")).toEqual(
        expect.arrayContaining(everything),
      );
    }
    const restrictedFound = await found(restricted, "scopesearch");
    expect(restrictedFound).toEqual(
      expect.arrayContaining([openThread, openSearchCard]),
    );
    for (const id of [hiddenThread, ...Object.values(hiddenSearch)]) {
      expect(restrictedFound).not.toContain(id);
    }

    // Live stream: the same edits reach owner and admin as updates; the
    // restricted member gets the visible one and a deletion for the rest.
    const live = await hiddenCards("live");
    const liveOpen = await createCard("live open", openId);
    const liveMoved = await createCard("live moved", openId);
    const streams = {
      owner: await watchBoard(ownerCtx, slug),
      admin: await watchBoard(admin, slug),
      restricted: await watchBoard(restricted, slug),
    };
    for (const id of [liveOpen, ...Object.values(live)]) {
      const res = await tool(ownerCtx, "TASK_BOARD_ITEM_UPDATE", {
        id,
        title: `live edit ${id}`,
      });
      expect(res.ok(), `live edit: ${await res.text()}`).toBe(true);
    }
    const move = await tool(ownerCtx, "TASK_BOARD_ITEM_UPDATE", {
      id: liveMoved,
      virtualMcpId: hiddenId,
    });
    expect(move.ok(), `move: ${await move.text()}`).toBe(true);

    const edited = [liveOpen, ...Object.values(live), liveMoved];
    const subjects = (events: BoardEvent[], type: string) =>
      events.filter((e) => e.type === type).map((e) => e.subject);
    for (const stream of Object.values(streams)) {
      await expect
        .poll(
          () =>
            edited.every((id) =>
              stream.events.some((event) => event.subject === id),
            ),
          {
            timeout: 15_000,
          },
        )
        .toBe(true);
    }
    for (const who of ["owner", "admin"] as const) {
      const { events } = streams[who];
      expect(subjects(events, "task-board.item.updated")).toEqual(
        expect.arrayContaining(edited),
      );
      expect(subjects(events, "task-board.item.deleted")).toEqual([]);
    }
    const seen = streams.restricted.events.filter((event) =>
      edited.includes(event.subject),
    );
    const updated = seen.filter((e) => e.type === "task-board.item.updated");
    expect(updated.map((e) => e.subject)).toEqual([liveOpen]);
    expect(updated[0]?.data.title).toBe(`live edit ${liveOpen}`);
    expect(subjects(seen, "task-board.item.deleted").sort()).toEqual(
      [...Object.values(live), liveMoved].sort(),
    );
    for (const event of seen) {
      if (event.type === "task-board.item.deleted") {
        expect(event.data).toEqual({ id: event.subject });
      }
    }
    for (const stream of Object.values(streams)) stream.close();

    await ownerCtx.dispose();
    await admin.dispose();
    await restricted.dispose();
  });
});
