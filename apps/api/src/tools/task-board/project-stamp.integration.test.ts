/**
 * Real-Postgres coverage for stamping a card with its project
 * (`task_board_items.virtual_mcp_id`): the project must be this org's and
 * within the caller's project scope, the card takes the project's repository
 * when it names none, and deleting the project releases the card.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { TaskBoardStorage } from "../../storage/task-board";
import { VirtualMCPStorage } from "../../storage/virtual";
import { TASK_BOARD_ITEM_CREATE } from "./create";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

const ORG = "org_stamp_1";
const OTHER_ORG = "org_stamp_2";
const USER = "user_stamp_1";

const SHARED_REPO = {
  url: "https://github.com/acme/storefront",
  owner: "acme",
  name: "storefront",
};

describe("project stamp on task board cards", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let virtualMcps: VirtualMCPStorage;
  let repositoryId: string;
  let role = "owner";
  let permissions: Record<string, string[]> | undefined;

  const insertProject = async (
    id: string,
    organizationId: string,
    repository: typeof SHARED_REPO | null,
  ) => {
    const now = new Date().toISOString();
    await database.db
      .insertInto("connections")
      .values({
        id,
        organization_id: organizationId,
        created_by: USER,
        updated_by: null,
        title: id,
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        slug: null,
        connection_type: "VIRTUAL",
        connection_url: `virtual://${id}`,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: JSON.stringify(
          repository ? { githubRepo: { ...repository, repositoryId } } : {},
        ),
        bindings: null,
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
  };

  const ctx = () =>
    ({
      timings: {
        measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
      },
      auth: {
        user: { id: USER, email: "stamp@test.com", name: USER },
        permissions,
        permissionsOrganizationId: ORG,
      },
      organization: { id: ORG, slug: ORG, name: ORG },
      storage: {
        taskBoard,
        virtualMcps,
        notifications: { notifyMentions: async () => {} },
      },
      access: {
        granted: () => true,
        check: async () => {},
        grant: () => {},
        setToolName: () => {},
        getRole: () => role,
      },
      metadata: { requestId: "req_test", timestamp: new Date() },
    }) as unknown as StudioContext;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    for (const org of [ORG, OTHER_ORG]) {
      await sql`
        INSERT INTO "organization" (id, name, slug, "createdAt")
        VALUES (${org}, ${org}, ${org}, ${now})
      `.execute(database.db);
    }
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, 'stamp@test.com', false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    virtualMcps = new VirtualMCPStorage(database.db);
    ({ id: repositoryId } = await database.db
      .insertInto("repositories")
      .values({
        organization_id: ORG,
        provider: "github",
        host: "github.com",
        path: "acme/storefront",
        web_url: SHARED_REPO.url,
      })
      .returning("id")
      .executeTakeFirstOrThrow());
    await insertProject("vir_north", ORG, SHARED_REPO);
    await insertProject("vir_south", ORG, SHARED_REPO);
    await insertProject("vir_ideas", ORG, null);
    await insertProject("vir_foreign", OTHER_ORG, SHARED_REPO);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("stamps the project and takes its repository when none is named", async () => {
    const { item } = await TASK_BOARD_ITEM_CREATE.handler(
      { title: "north card", virtualMcpId: "vir_north" },
      ctx(),
    );
    expect(item).toMatchObject({
      virtualMcpId: "vir_north",
      repo: "acme/storefront",
      repositoryId,
    });
    const reread = await taskBoard.getById(item.id, ORG);
    expect(reread?.virtualMcpId).toBe("vir_north");
  });

  it("keeps an explicit repository and drops an id that names another", async () => {
    const { item } = await TASK_BOARD_ITEM_CREATE.handler(
      { title: "elsewhere", virtualMcpId: "vir_north", repo: "acme/other" },
      ctx(),
    );
    expect(item).toMatchObject({
      virtualMcpId: "vir_north",
      repo: "acme/other",
      repositoryId: null,
    });
  });

  it("stamps a project with no repository", async () => {
    const { item } = await TASK_BOARD_ITEM_CREATE.handler(
      { title: "idea", virtualMcpId: "vir_ideas" },
      ctx(),
    );
    expect(item).toMatchObject({ virtualMcpId: "vir_ideas", repo: null });
  });

  it("refuses another org's project and an unknown one", async () => {
    for (const virtualMcpId of ["vir_foreign", "vir_missing"]) {
      await expect(
        TASK_BOARD_ITEM_CREATE.handler({ title: "nope", virtualMcpId }, ctx()),
      ).rejects.toThrow(`Project not found: ${virtualMcpId}`);
    }
  });

  it("refuses a project outside the caller's role scope", async () => {
    role = "project-scoped";
    permissions = { projects: ["vir_north"] };
    try {
      await expect(
        TASK_BOARD_ITEM_CREATE.handler(
          { title: "nope", virtualMcpId: "vir_south" },
          ctx(),
        ),
      ).rejects.toThrow("Project not found: vir_south");
      const { item } = await TASK_BOARD_ITEM_CREATE.handler(
        { title: "allowed", virtualMcpId: "vir_north" },
        ctx(),
      );
      expect(item.virtualMcpId).toBe("vir_north");
    } finally {
      role = "owner";
      permissions = undefined;
    }
  });

  it("moves a card between projects and clears it", async () => {
    const { item } = await TASK_BOARD_ITEM_CREATE.handler(
      { title: "mover", repo: "acme/storefront" },
      ctx(),
    );
    expect(item.virtualMcpId).toBeNull();

    const moved = await TASK_BOARD_ITEM_UPDATE.handler(
      { id: item.id, virtualMcpId: "vir_south" },
      ctx(),
    );
    expect(moved.item).toMatchObject({
      virtualMcpId: "vir_south",
      repo: "acme/storefront",
      repositoryId,
    });

    await expect(
      TASK_BOARD_ITEM_UPDATE.handler(
        { id: item.id, virtualMcpId: "vir_foreign" },
        ctx(),
      ),
    ).rejects.toThrow("Project not found: vir_foreign");

    // The dialog resends the unchanged project with every autosave.
    const renamed = await TASK_BOARD_ITEM_UPDATE.handler(
      {
        id: item.id,
        title: "renamed",
        virtualMcpId: "vir_south",
        repo: "acme/storefront",
      },
      ctx(),
    );
    expect(renamed.item).toMatchObject({
      virtualMcpId: "vir_south",
      repositoryId,
    });

    const cleared = await TASK_BOARD_ITEM_UPDATE.handler(
      { id: item.id, virtualMcpId: null, repo: null },
      ctx(),
    );
    expect(cleared.item).toMatchObject({
      virtualMcpId: null,
      repo: null,
      repositoryId: null,
    });
  });

  it("releases its cards when the project is deleted", async () => {
    await insertProject("vir_doomed", ORG, null);
    const { item } = await TASK_BOARD_ITEM_CREATE.handler(
      { title: "orphan-to-be", virtualMcpId: "vir_doomed" },
      ctx(),
    );
    await virtualMcps.delete("vir_doomed");
    const reread = await taskBoard.getById(item.id, ORG);
    expect(reread?.virtualMcpId).toBeNull();
  });
});
