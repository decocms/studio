import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sharedSandboxId, userSandboxId } from "@decocms/sandbox/provider";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { KyselyAgentSandboxRunnerStateStore } from "./agent-sandbox-runner-state";
import { AgentSandboxSessionStorage } from "./agent-sandbox-sessions";

describe("shared agent sandbox storage", () => {
  let database: StudioDatabase;
  let sessions: AgentSandboxSessionStorage;
  let runnerState: KyselyAgentSandboxRunnerStateStore;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: "org_shared_sandbox",
        name: "Shared Sandbox Org",
        slug: "shared-sandbox-org",
        createdAt: new Date().toISOString(),
      })
      .execute();
    sessions = new AgentSandboxSessionStorage(database.db);
    runnerState = new KyselyAgentSandboxRunnerStateStore(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("stores runner state once per project regardless of acting user", async () => {
    const id = sharedSandboxId("org:vm:branch");
    await runnerState.put(id, "agent-sandbox", {
      handle: "shared-handle",
      state: { phase: "ready" },
    });

    expect(await runnerState.get(id, "agent-sandbox")).toMatchObject({
      handle: "shared-handle",
      state: { phase: "ready" },
    });
    expect(
      await runnerState.getByHandle("agent-sandbox", "shared-handle"),
    ).toMatchObject({ id });
    await expect(
      runnerState.get(
        userSandboxId("user_2", "org:vm:branch"),
        "agent-sandbox",
      ),
    ).rejects.toThrow("only accepts shared sandbox ids");
  });

  it("coalesces concurrent starts and fences a completion after stop", async () => {
    const locator = {
      organizationId: "org_shared_sandbox",
      virtualMcpId: "vm_shared",
      branch: "feature/shared",
    };
    const [first, second] = await Promise.all([
      sessions.beginStart(locator, "user_1", null),
      sessions.beginStart(locator, "user_2", null),
    ]);
    expect(first.generation).toBe(second.generation);
    expect(first.desiredState).toBe("running");
    expect(second.desiredState).toBe("running");

    const stopping = await sessions.withLock(locator, (locked) =>
      locked.beginStop(locator, "user_2"),
    );
    expect(stopping).toMatchObject({
      desiredState: "stopped",
      status: "stopping",
    });
    if (!stopping) throw new Error("expected stopping session");
    expect(
      await sessions.completeStart(locator, first.generation, {
        sandboxHandle: "too-late",
        previewUrl: "https://too-late.example",
        sandboxProviderKind: "agent-sandbox",
      }),
    ).toBeNull();
    await sessions.withLock(locator, (locked) =>
      locked.completeStop(locator, stopping.generation),
    );
    const stopped = await sessions.find(locator);
    expect(stopped).toMatchObject({
      desiredState: "stopped",
      status: "stopped",
    });
    if (!stopped) throw new Error("expected stopped session");

    const restarted = await sessions.beginStart(locator, "user_1", null);
    expect(restarted.generation).toBeGreaterThan(stopped.generation);
    const ready = await sessions.completeStart(locator, restarted.generation, {
      sandboxHandle: "shared-ready",
      previewUrl: "https://shared.example",
      sandboxProviderKind: "agent-sandbox",
    });
    expect(ready).toMatchObject({
      sandboxHandle: "shared-ready",
      previewUrl: "https://shared.example",
      desiredState: "running",
      status: "ready",
      lastStartedBy: "user_1",
    });
  });

  it("commits failed provisioning state and its cleanup handle under the lifecycle lock", async () => {
    const locator = {
      organizationId: "org_shared_sandbox",
      virtualMcpId: "vm_failed",
      branch: "feature/failed",
    };
    await sessions.withLock(locator, async (locked) => {
      const started = await locked.beginStart(locator, "user_1", null);
      await locked.recordProvisioningHandle(
        locator,
        started.generation,
        "failed-handle",
      );
      await locked.failStart(locator, started.generation, "clone failed");
    });

    expect(await sessions.find(locator)).toMatchObject({
      sandboxHandle: "failed-handle",
      desiredState: "running",
      status: "failed",
      failureReason: "clone failed",
    });
  });

  it("fences starts while parent cleanup owns the session", async () => {
    const locator = {
      organizationId: "org_shared_sandbox",
      virtualMcpId: "vm_deleting",
      branch: "feature/deleting",
    };
    await sessions.beginStart(locator, "user_1", null);
    const deleting = await sessions.withLock(locator, (locked) =>
      locked.beginDelete(locator, "user_1"),
    );
    expect(deleting).toMatchObject({
      desiredState: "stopped",
      status: "deleting",
    });
    if (!deleting) throw new Error("expected deleting session");
    await expect(
      sessions.withLock(locator, (locked) =>
        locked.beginStart(locator, "user_2", null),
      ),
    ).rejects.toThrow("lifecycle transition in progress");

    await sessions.withLock(locator, (locked) =>
      locked.completeDelete(locator, deleting.generation),
    );
    expect(await sessions.find(locator)).toBeNull();
  });
});
