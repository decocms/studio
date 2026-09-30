import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import {
  AppPreviewSessionStorage,
  MAX_OVERLAY_BYTES,
  newDeviceToken,
  newPairingCode,
  OverlayTooLargeError,
  sha256Hex,
} from "./app-preview-sessions";

const owner = {
  organizationId: "org_1",
  virtualMcpId: "vir_1",
  userId: "user_1",
};
const T0 = new Date("2026-01-01T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("AppPreviewSessionStorage", () => {
  let database: StudioDatabase;
  let storage: AppPreviewSessionStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new AppPreviewSessionStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("app_preview_sessions").execute();
    await database.db.deleteFrom("member").execute();
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_1', 'user_1', 'org_1', 'member', now())
    `.execute(database.db);
  });

  const create = (code = newPairingCode(), now = T0) =>
    storage.create({ ...owner, branch: "main", pairingCode: code }, now);

  it("stores only hashes of the code and the token", async () => {
    const code = newPairingCode();
    const token = newDeviceToken();
    const session = await create(code);
    expect(await storage.claim(code, "org_1", token, T0)).not.toBeNull();
    const rows = await database.db
      .selectFrom("app_preview_devices")
      .select("token_hash")
      .execute();
    expect(rows).toEqual([{ token_hash: sha256Hex(token) }]);
    const s = await database.db
      .selectFrom("app_preview_sessions")
      .select("pairing_code_hash")
      .where("id", "=", session.id)
      .executeTakeFirstOrThrow();
    expect(s.pairing_code_hash).toBeNull();
  });

  it("claim is single use and fails closed on expiry, org and membership", async () => {
    const code = newPairingCode();
    await create(code);
    expect(await storage.claim(code, "org_2", newDeviceToken(), T0)).toBeNull();
    expect(
      await storage.claim(code, "org_1", newDeviceToken(), T0),
    ).not.toBeNull();
    expect(await storage.claim(code, "org_1", newDeviceToken(), T0)).toBeNull();

    const late = newPairingCode();
    await create(late);
    expect(
      await storage.claim(
        late,
        "org_1",
        newDeviceToken(),
        at(10 * 60 * 1000 + 1),
      ),
    ).toBeNull();

    const orphan = newPairingCode();
    await create(orphan);
    await database.db.deleteFrom("member").execute();
    expect(
      await storage.claim(orphan, "org_1", newDeviceToken(), T0),
    ).toBeNull();
  });

  it("caps active devices at 5 and burns the code anyway", async () => {
    const session = await create();
    for (let i = 0; i < 5; i++) {
      const code = newPairingCode();
      await storage.rotatePairing(session.id, owner, code, T0);
      expect(
        await storage.claim(code, "org_1", newDeviceToken(), T0),
      ).not.toBeNull();
    }
    const sixth = newPairingCode();
    await storage.rotatePairing(session.id, owner, sixth, T0);
    expect(
      await storage.claim(sixth, "org_1", newDeviceToken(), T0),
    ).toBeNull();
    const found = await storage.getForOwner(session.id, owner);
    expect(found?.devices).toHaveLength(5);
    expect(found?.session.pairingExpiresAt).toBeNull();
  });

  it("authenticates a device until revoke, expiry or the creator leaves", async () => {
    const code = newPairingCode();
    const token = newDeviceToken();
    const session = await create(code);
    await storage.claim(code, "org_1", token, T0);

    const ok = await storage.authenticateDevice(token, "org_1", at(1000));
    expect(ok?.session.id).toBe(session.id);
    expect(
      await storage.authenticateDevice(token, "org_2", at(1000)),
    ).toBeNull();
    expect(
      await storage.authenticateDevice(newDeviceToken(), "org_1", at(1000)),
    ).toBeNull();
    expect(
      await storage.authenticateDevice(
        token,
        "org_1",
        at(2 * 60 * 60 * 1000 + 1),
      ),
    ).toBeNull();

    await database.db.deleteFrom("member").execute();
    expect(
      await storage.authenticateDevice(token, "org_1", at(1000)),
    ).toBeNull();
  });

  it("revokeDevice and revoke kill the token; revoke is idempotent", async () => {
    const code = newPairingCode();
    const token = newDeviceToken();
    const session = await create(code);
    await storage.claim(code, "org_1", token, T0);
    const auth = await storage.authenticateDevice(token, "org_1", T0);
    await storage.revokeDevice(auth!.deviceId, T0);
    expect(await storage.authenticateDevice(token, "org_1", T0)).toBeNull();

    expect(await storage.revoke(session.id, owner, T0)).toBe(true);
    expect(await storage.revoke(session.id, owner, at(5000))).toBe(true);
    expect(
      (await storage.getForOwner(session.id, owner))?.session.revokedAt,
    ).toBe(T0.toISOString());
    expect(
      await storage.revoke(session.id, { ...owner, userId: "user_123" }, T0),
    ).toBe(false);
  });

  it("is owner-only", async () => {
    const session = await create();
    expect(
      await storage.getForOwner(session.id, { ...owner, userId: "user_123" }),
    ).toBeNull();
    expect(
      await storage.patchOverlay(
        session.id,
        { ...owner, virtualMcpId: "vir_2" },
        { reset: true },
      ),
    ).toBeNull();
  });

  it("merges overlay patches and bumps rev", async () => {
    const session = await create();
    expect(
      await storage.patchOverlay(
        session.id,
        owner,
        { set: { a: { x: 1 }, b: { y: 2 } } },
        T0,
      ),
    ).toEqual({ rev: 1 });
    expect(
      await storage.patchOverlay(session.id, owner, { delete: ["a"] }, T0),
    ).toEqual({
      rev: 2,
    });
    const code = newPairingCode();
    const token = newDeviceToken();
    await storage.rotatePairing(session.id, owner, code, T0);
    await storage.claim(code, "org_1", token, T0);
    const auth = await storage.authenticateDevice(token, "org_1", T0);
    expect(auth?.session.overlay).toEqual({
      set: { b: { y: 2 } },
      delete: ["a"],
    });
    expect(auth?.session.rev).toBe(2);
  });

  it("rejects an overlay past 8 MB without bumping rev", async () => {
    const session = await create();
    const big = "x".repeat(900 * 1024);
    for (let i = 0; i < 9; i++) {
      await storage.patchOverlay(
        session.id,
        owner,
        { set: { [`b${i}`]: { big } } },
        T0,
      );
    }
    await expect(
      storage.patchOverlay(session.id, owner, { set: { b9: { big } } }, T0),
    ).rejects.toBeInstanceOf(OverlayTooLargeError);
    expect(9 * 900 * 1024 < MAX_OVERLAY_BYTES).toBe(true);
    expect((await storage.getForOwner(session.id, owner))?.session.rev).toBe(9);
  });

  it("keeps at most 10 active sessions per user and project", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++)
      ids.push((await create(newPairingCode(), at(i))).id);
    const oldest = await storage.getForOwner(ids[0]!, owner);
    expect(oldest?.session.revokedAt).not.toBeNull();
    const newest = await storage.getForOwner(ids[10]!, owner);
    expect(newest?.session.revokedAt).toBeNull();
  });

  it("deleteExpired drops sessions dead before the cutoff", async () => {
    const session = await create();
    await storage.deleteExpired(at(60 * 60 * 1000));
    expect(await storage.getForOwner(session.id, owner)).not.toBeNull();
    await storage.deleteExpired(at(3 * 60 * 60 * 1000));
    expect(await storage.getForOwner(session.id, owner)).toBeNull();
  });
});
