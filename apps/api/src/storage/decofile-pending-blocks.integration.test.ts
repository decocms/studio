import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { DecofilePendingBlockStorage } from "./decofile-pending-blocks";

const ORG = "org_test";
const SCOPE = { organizationId: ORG, virtualMcpId: "vmcp_1", branch: "draft" };
const OTHER_BRANCH = { ...SCOPE, branch: "other" };
const noCheck = async () => {};

describe("DecofilePendingBlockStorage", () => {
  let database: StudioDatabase;
  let storage: DecofilePendingBlockStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("connections")
      .values({
        id: SCOPE.virtualMcpId,
        organization_id: ORG,
        created_by: "user_1",
        updated_by: null,
        title: "Site",
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        slug: null,
        connection_type: "VIRTUAL",
        connection_url: "",
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: null,
        bindings: null,
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
    storage = new DecofilePendingBlockStorage(database.db);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("decofile_pending_blocks").execute();
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("keeps one row per block, a delete as null, and scopes rows to the branch", async () => {
    await storage.write(
      SCOPE,
      { set: { home: { v: 1 } }, delete: ["gone"] },
      "user_1",
      noCheck,
    );
    await storage.write(
      SCOPE,
      { set: { home: { v: 2 } }, delete: [] },
      "user_1",
      noCheck,
    );
    await storage.write(
      OTHER_BRANCH,
      { set: { home: { v: 9 } }, delete: [] },
      null,
      noCheck,
    );

    const rows = await storage.list(SCOPE);
    expect(rows.map((r) => [r.blockKey, r.content])).toEqual([
      ["gone", null],
      ["home", { v: 2 }],
    ]);
    expect((await storage.list(OTHER_BRANCH)).map((r) => r.content)).toEqual([
      { v: 9 },
    ]);
  });

  it("keeps a block's key order", async () => {
    await storage.write(
      SCOPE,
      { set: { home: { title: "t", __resolveType: "x" } }, delete: [] },
      null,
      noCheck,
    );
    const [row] = await storage.list(SCOPE);
    expect(Object.keys(row?.content ?? {})).toEqual(["title", "__resolveType"]);
  });

  it("gives a block a new revision on every write", async () => {
    await storage.write(
      SCOPE,
      { set: { home: {} }, delete: [] },
      null,
      noCheck,
    );
    const [first] = await storage.list(SCOPE);
    await storage.write(
      SCOPE,
      { set: { home: {} }, delete: [] },
      null,
      noCheck,
    );
    const [second] = await storage.list(SCOPE);
    expect(BigInt(second?.revision ?? "0")).toBeGreaterThan(
      BigInt(first?.revision ?? "0"),
    );
  });

  it("writes nothing when the check throws, and hands it the current rows", async () => {
    await storage.write(
      SCOPE,
      { set: { home: { v: 1 } }, delete: [] },
      null,
      noCheck,
    );
    const seen: string[] = [];
    const failed = await storage
      .write(
        SCOPE,
        { set: { home: { v: 2 }, about: {} }, delete: [] },
        null,
        async (current) => {
          seen.push(...current.keys());
          throw new Error("stale");
        },
      )
      .then(
        () => null,
        (err: Error) => err.message,
      );
    expect(failed).toBe("stale");
    expect(seen).toEqual(["home"]);
    expect((await storage.list(SCOPE)).map((r) => r.content)).toEqual([
      { v: 1 },
    ]);
  });

  it("serializes concurrent writes to one branch", async () => {
    // Each check reads what the other wrote: never both against an empty table.
    const sizes: number[] = [];
    await Promise.all(
      ["a", "b"].map((key) =>
        storage.write(
          SCOPE,
          { set: { [key]: {} }, delete: [] },
          null,
          async (current) => {
            sizes.push(current.size);
          },
        ),
      ),
    );
    expect(sizes.sort()).toEqual([0, 1]);
  });

  it("deletes a row only while it holds the revision that was read", async () => {
    await storage.write(
      SCOPE,
      { set: { home: {}, about: {} }, delete: [] },
      null,
      noCheck,
    );
    const read = await storage.list(SCOPE);
    // `home` saved again after the read: the commit did not carry it.
    await storage.write(
      SCOPE,
      { set: { home: { v: 2 } }, delete: [] },
      null,
      noCheck,
    );
    await storage.deleteRevisions(SCOPE, read);
    expect(
      (await storage.list(SCOPE)).map((r) => [r.blockKey, r.content]),
    ).toEqual([["home", { v: 2 }]]);
  });

  it("drops chosen blocks whatever their revision", async () => {
    await storage.write(
      SCOPE,
      { set: { home: {}, about: {} }, delete: [] },
      null,
      noCheck,
    );
    await storage.deleteKeys(SCOPE, ["home"]);
    expect((await storage.list(SCOPE)).map((r) => r.blockKey)).toEqual([
      "about",
    ]);
  });

  it("goes away with its project", async () => {
    await storage.write(
      SCOPE,
      { set: { home: {} }, delete: [] },
      null,
      noCheck,
    );
    await database.db
      .deleteFrom("connections")
      .where("id", "=", SCOPE.virtualMcpId)
      .execute();
    expect(await storage.list(SCOPE)).toEqual([]);
  });
});
