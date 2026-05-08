import { describe, expect, it, mock } from "bun:test";
import type { MeshContext } from "@/core/mesh-context";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation } from "@/storage/types";
import {
  fireAutomation,
  type FireAutomationConfig,
  type StreamCoreFn,
} from "./fire";
import { Semaphore } from "./semaphore";

// ============================================================================
// Helpers
// ============================================================================

const ORG_ID = "org_test";
const USER_ID = "user_test";

function makeAutomation(overrides?: Partial<Automation>): Automation {
  return {
    id: "auto_1",
    organization_id: ORG_ID,
    name: "Test Automation",
    active: true,
    created_by: USER_ID,
    messages: JSON.stringify([
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ]),
    models: JSON.stringify({
      main: { id: "model-1" },
      thinking: { id: "model-2" },
      credentialId: "cred_1",
    }),
    temperature: 0.5,
    virtual_mcp_id: "agent_1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeConfig(): FireAutomationConfig {
  return { maxConcurrentPerAutomation: 3, runTimeoutMs: 60_000 };
}

function makeStorage(
  overrides?: Partial<AutomationsStorage>,
): AutomationsStorage {
  return {
    deactivateAutomation: mock(() => Promise.resolve()),
    tryAcquireRunSlot: mock(() => Promise.resolve("thrd_1")),
    markRunFailed: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as AutomationsStorage;
}

function makeMeshContext(orgId: string): MeshContext {
  return {
    organization: { id: orgId, slug: "test", name: "Test Org" },
    storage: {
      threads: { _orgId: orgId },
      organizationSettings: { get: mock(() => Promise.resolve(null)) },
    },
  } as unknown as MeshContext;
}

function makeDeps() {
  return {
    runRegistry: {
      register: mock(() => () => {}),
      get: mock(() => undefined),
    },
    cancelBroadcast: {
      subscribe: mock(() => () => {}),
      broadcast: mock(() => {}),
    },
  } as any;
}

function makeEmptyStream() {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("fireAutomation", () => {
  it("skips when global semaphore is full", async () => {
    const semaphore = new Semaphore(0);
    const result = await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage: makeStorage(),
      streamCoreFn: mock(() =>
        Promise.resolve({ taskId: "t", stream: makeEmptyStream() }),
      ),
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: semaphore,
      deps: makeDeps(),
    });
    expect(result).toEqual({ skipped: "global_limit" });
  });

  it("does not call meshContextFactory when global semaphore is full", async () => {
    const factory = mock(() => Promise.resolve(makeMeshContext(ORG_ID)));
    await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage: makeStorage(),
      streamCoreFn: mock(() =>
        Promise.resolve({ taskId: "t", stream: makeEmptyStream() }),
      ),
      meshContextFactory: factory,
      config: makeConfig(),
      globalSemaphore: new Semaphore(0),
      deps: makeDeps(),
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("deactivates and skips when creator is no longer in org", async () => {
    const storage = makeStorage();
    const result = await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage,
      streamCoreFn: mock(() =>
        Promise.resolve({ taskId: "t", stream: makeEmptyStream() }),
      ),
      meshContextFactory: mock(() => Promise.resolve(null)),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });
    expect(result).toEqual({ skipped: "creator_invalid" });
    expect(storage.deactivateAutomation).toHaveBeenCalledWith("auto_1");
  });

  it("passes automation.organization_id and created_by to meshContextFactory", async () => {
    const factory = mock(() => Promise.resolve(null));
    const automation = makeAutomation({
      organization_id: "org_xyz",
      created_by: "user_abc",
    });
    await fireAutomation({
      automation,
      triggerId: null,
      storage: makeStorage(),
      streamCoreFn: mock(() =>
        Promise.resolve({ taskId: "t", stream: makeEmptyStream() }),
      ),
      meshContextFactory: factory,
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });
    expect(factory).toHaveBeenCalledWith("org_xyz", "user_abc");
  });

  it("skips when concurrency limit is reached", async () => {
    const storage = makeStorage({
      tryAcquireRunSlot: mock(() => Promise.resolve(null)),
    });
    const result = await fireAutomation({
      automation: makeAutomation(),
      triggerId: "trig_1",
      storage,
      streamCoreFn: mock(() =>
        Promise.resolve({ taskId: "t", stream: makeEmptyStream() }),
      ),
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });
    expect(result).toEqual({ skipped: "concurrency_limit" });
  });

  it("passes triggerId to tryAcquireRunSlot", async () => {
    const storage = makeStorage();
    await fireAutomation({
      automation: makeAutomation(),
      triggerId: "trig_99",
      storage,
      streamCoreFn: mock(async () => ({
        taskId: "thrd_1",
        stream: makeEmptyStream(),
      })),
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });
    expect(storage.tryAcquireRunSlot).toHaveBeenCalledWith(
      "auto_1",
      "trig_99",
      3,
    );
  });

  it("passes the context from meshContextFactory to streamCoreFn", async () => {
    const ctx = makeMeshContext(ORG_ID);
    let receivedCtx: MeshContext | undefined;

    const streamCoreFn: StreamCoreFn = mock(async (_input, c) => {
      receivedCtx = c;
      return { taskId: "thrd_1", stream: makeEmptyStream() };
    });

    const result = await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage: makeStorage(),
      streamCoreFn,
      meshContextFactory: mock(() => Promise.resolve(ctx)),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });

    expect(result).toEqual({ taskId: "thrd_1" });
    expect(receivedCtx).toBe(ctx);
  });

  it("returns error when streamCoreFn throws", async () => {
    const streamCoreFn: StreamCoreFn = mock(async () => {
      throw new Error("stream failed");
    });

    const storage = makeStorage();
    const result = await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage,
      streamCoreFn,
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });

    expect(result).toEqual({ taskId: "thrd_1", error: "stream failed" });
    expect(storage.markRunFailed).toHaveBeenCalledWith("thrd_1");
  });

  it("still returns error result when markRunFailed itself throws", async () => {
    const storage = makeStorage({
      markRunFailed: mock(() => Promise.reject(new Error("db down"))),
    });

    const result = await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage,
      streamCoreFn: mock(async () => {
        throw new Error("boom");
      }),
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });

    expect(result).toEqual({ taskId: "thrd_1", error: "boom" });
  });

  it("releases global semaphore on success", async () => {
    const semaphore = new Semaphore(1);
    await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage: makeStorage(),
      streamCoreFn: mock(async () => ({
        taskId: "thrd_1",
        stream: makeEmptyStream(),
      })),
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: semaphore,
      deps: makeDeps(),
    });
    expect(semaphore.available).toBe(1);
  });

  it("releases global semaphore on streamCoreFn error", async () => {
    const semaphore = new Semaphore(1);
    await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage: makeStorage(),
      streamCoreFn: mock(async () => {
        throw new Error("boom");
      }),
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: semaphore,
      deps: makeDeps(),
    });
    expect(semaphore.available).toBe(1);
  });

  it("releases global semaphore when creator is invalid", async () => {
    const semaphore = new Semaphore(1);
    await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage: makeStorage(),
      streamCoreFn: mock(async () => ({
        taskId: "t",
        stream: makeEmptyStream(),
      })),
      meshContextFactory: mock(() => Promise.resolve(null)),
      config: makeConfig(),
      globalSemaphore: semaphore,
      deps: makeDeps(),
    });
    expect(semaphore.available).toBe(1);
  });

  it("appends context messages when provided", async () => {
    let receivedInput: any;
    const streamCoreFn: StreamCoreFn = mock(async (input) => {
      receivedInput = input;
      return { taskId: "thrd_1", stream: makeEmptyStream() };
    });

    await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      contextMessages: [{ role: "system", content: "event data here" }],
      storage: makeStorage(),
      streamCoreFn,
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });

    expect(receivedInput.messages).toHaveLength(2);
    expect(receivedInput.messages[1].role).toBe("system");
    expect(receivedInput.messages[1].parts[0].text).toBe("event data here");
  });

  it("does not mutate original messages when appending context", async () => {
    const automation = makeAutomation();
    const originalMessages = JSON.parse(automation.messages);

    await fireAutomation({
      automation,
      triggerId: null,
      contextMessages: [{ role: "system", content: "extra" }],
      storage: makeStorage(),
      streamCoreFn: mock(async () => ({
        taskId: "thrd_1",
        stream: makeEmptyStream(),
      })),
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });

    // Original automation.messages should be unchanged
    expect(JSON.parse(automation.messages)).toEqual(originalMessages);
  });

  it("converts non-Error throws to string in error result", async () => {
    const result = await fireAutomation({
      automation: makeAutomation(),
      triggerId: null,
      storage: makeStorage(),
      streamCoreFn: mock(async () => {
        throw "string error";
      }),
      meshContextFactory: mock(() => Promise.resolve(makeMeshContext(ORG_ID))),
      config: makeConfig(),
      globalSemaphore: new Semaphore(10),
      deps: makeDeps(),
    });
    expect(result).toEqual({ taskId: "thrd_1", error: "string error" });
  });
});
