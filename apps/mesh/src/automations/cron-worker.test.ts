import { describe, expect, it, mock } from "bun:test";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation, AutomationTrigger } from "@/storage/types";
import type { MeshContext } from "@/core/mesh-context";
import type { StreamCoreFn, FireAutomationConfig } from "./fire";
import { AutomationCronWorker } from "./cron-worker";
import { Semaphore } from "./semaphore";

// ============================================================================
// Helpers
// ============================================================================

const ORG_ID = "org_test";
const USER_ID = "user_test";
const FIXED_NOW = new Date("2026-03-12T12:00:00Z");

function makeAutomation(overrides?: Partial<Automation>): Automation {
  return {
    id: "auto_1",
    organization_id: ORG_ID,
    name: "Test",
    active: true,
    created_by: USER_ID,
    agent: JSON.stringify({ id: "agent_1" }),
    messages: JSON.stringify([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ]),
    models: JSON.stringify({
      main: { id: "m1" },
      thinking: { id: "m2" },
      credentialId: "cred_1",
    }),
    temperature: 0.5,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeTrigger(
  overrides?: Partial<AutomationTrigger>,
): AutomationTrigger {
  return {
    id: "trig_1",
    automation_id: "auto_1",
    type: "cron",
    cron_expression: "*/5 * * * *",
    connection_id: null,
    event_type: null,
    params: null,
    last_run_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeMeshContext(): MeshContext {
  return {
    organization: { id: ORG_ID, slug: "test", name: "Test" },
    storage: { threads: {} },
  } as unknown as MeshContext;
}

function makeEmptyStream() {
  return new ReadableStream({
    start(c) {
      c.close();
    },
  });
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

interface MockStorage extends AutomationsStorage {
  findAllActiveCronTriggers: ReturnType<typeof mock>;
  updateTriggerLastRunAt: ReturnType<typeof mock>;
  tryAcquireRunSlot: ReturnType<typeof mock>;
  deactivateAutomation: ReturnType<typeof mock>;
  markRunFailed: ReturnType<typeof mock>;
}

function makeStorage(overrides?: Partial<MockStorage>): MockStorage {
  return {
    findAllActiveCronTriggers: mock(() => Promise.resolve([])),
    updateTriggerLastRunAt: mock(() => Promise.resolve()),
    tryAcquireRunSlot: mock(() => Promise.resolve("thrd_1")),
    deactivateAutomation: mock(() => Promise.resolve()),
    markRunFailed: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as MockStorage;
}

function makeWorker(opts?: {
  storage?: MockStorage;
  streamCoreFn?: StreamCoreFn;
  meshContextFactory?: (
    orgId: string,
    userId: string,
  ) => Promise<MeshContext | null>;
  config?: FireAutomationConfig;
  semaphore?: Semaphore;
  now?: () => Date;
}) {
  const storage = opts?.storage ?? makeStorage();
  const streamCoreFn: StreamCoreFn =
    opts?.streamCoreFn ??
    mock(async () => ({ threadId: "thrd_1", stream: makeEmptyStream() }));
  const factory =
    opts?.meshContextFactory ?? mock(() => Promise.resolve(makeMeshContext()));
  const config = opts?.config ?? {
    maxConcurrentPerAutomation: 3,
    runTimeoutMs: 60_000,
  };
  const semaphore = opts?.semaphore ?? new Semaphore(10);

  const worker = new AutomationCronWorker(
    storage,
    streamCoreFn,
    factory,
    config,
    semaphore,
    makeDeps(),
    opts?.now ?? (() => FIXED_NOW),
  );

  return { worker, storage, streamCoreFn, factory };
}

// ============================================================================
// Tests
// ============================================================================

describe("AutomationCronWorker", () => {
  describe("isDue", () => {
    it("returns true when trigger has never run", () => {
      // Every 5 minutes — at 12:00 there was a scheduled time at 12:00
      expect(AutomationCronWorker.isDue("*/5 * * * *", null, FIXED_NOW)).toBe(
        true,
      );
    });

    it("returns true when previous scheduled time is after last_run_at", () => {
      // Every 5 minutes, last ran at 11:50, now 12:00 — 11:55 was missed
      expect(
        AutomationCronWorker.isDue(
          "*/5 * * * *",
          "2026-03-12T11:50:00Z",
          FIXED_NOW,
        ),
      ).toBe(true);
    });

    it("returns false when next scheduled occurrence is still in the future", () => {
      // Every 5 minutes, last ran at 12:00:01 — next after that is 12:05 > 12:00
      expect(
        AutomationCronWorker.isDue(
          "*/5 * * * *",
          "2026-03-12T12:00:01Z",
          FIXED_NOW,
        ),
      ).toBe(false);
    });

    it("returns false for invalid cron expression", () => {
      expect(AutomationCronWorker.isDue("not a cron", null, FIXED_NOW)).toBe(
        false,
      );
    });
  });

  describe("processNow", () => {
    it("does nothing when not started", async () => {
      const { worker, storage } = makeWorker();
      // Don't call start()
      await worker.processNow();
      expect(storage.findAllActiveCronTriggers).not.toHaveBeenCalled();
    });

    it("queries all active cron triggers", async () => {
      const { worker, storage } = makeWorker();
      await worker.start();
      await worker.processNow();
      expect(storage.findAllActiveCronTriggers).toHaveBeenCalled();
    });

    it("fires automation for due triggers", async () => {
      // last_run_at is null so it's due
      const trigger = makeTrigger({ last_run_at: null });
      const automation = makeAutomation();
      const storage = makeStorage({
        findAllActiveCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker, streamCoreFn } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      expect(streamCoreFn).toHaveBeenCalled();
    });

    it("does not fire triggers that are not due", async () => {
      // Hourly cron, last ran at 12:00:01 — next after that is 13:00 > 12:00
      const trigger = makeTrigger({
        cron_expression: "0 * * * *",
        last_run_at: "2026-03-12T12:00:01Z",
      });
      const automation = makeAutomation();
      const storage = makeStorage({
        findAllActiveCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker, streamCoreFn } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      expect(streamCoreFn).not.toHaveBeenCalled();
    });

    it("records last_run_at BEFORE firing automation", async () => {
      const callOrder: string[] = [];
      const trigger = makeTrigger({ last_run_at: null });
      const automation = makeAutomation();

      const storage = makeStorage({
        findAllActiveCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
        updateTriggerLastRunAt: mock(() => {
          callOrder.push("updateLastRunAt");
          return Promise.resolve();
        }),
      });

      const streamCoreFn: StreamCoreFn = mock(async () => {
        callOrder.push("fire");
        return { threadId: "thrd_1", stream: makeEmptyStream() };
      });

      const { worker } = makeWorker({ storage, streamCoreFn });
      await worker.start();
      await worker.processNow();

      expect(callOrder.indexOf("updateLastRunAt")).toBeLessThan(
        callOrder.indexOf("fire"),
      );
    });

    it("handles multiple due triggers in parallel", async () => {
      const t1 = makeTrigger({ id: "trig_1", last_run_at: null });
      const t2 = makeTrigger({ id: "trig_2", last_run_at: null });
      const a1 = makeAutomation({ id: "auto_1" });
      const a2 = makeAutomation({ id: "auto_2" });

      const storage = makeStorage({
        findAllActiveCronTriggers: mock(() =>
          Promise.resolve([
            { ...t1, automation: a1 },
            { ...t2, automation: a2 },
          ]),
        ),
      });

      const { worker, streamCoreFn } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      expect((streamCoreFn as any).mock.calls.length).toBe(2);
    });

    it("does not crash when one trigger fails", async () => {
      const t1 = makeTrigger({ id: "trig_1", last_run_at: null });
      const t2 = makeTrigger({ id: "trig_2", last_run_at: null });
      const a1 = makeAutomation({ id: "auto_1" });
      const a2 = makeAutomation({ id: "auto_2" });

      let callCount = 0;
      const storage = makeStorage({
        findAllActiveCronTriggers: mock(() =>
          Promise.resolve([
            { ...t1, automation: a1 },
            { ...t2, automation: a2 },
          ]),
        ),
        updateTriggerLastRunAt: mock(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error("db error"));
          }
          return Promise.resolve();
        }),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();

      // Should not throw
      await worker.processNow();
    });
  });

  describe("coalescing", () => {
    it("coalesces concurrent processNow calls", async () => {
      let resolveProcess: (() => void) | undefined;
      let processNowCallCount = 0;

      const storage = makeStorage({
        findAllActiveCronTriggers: mock(() => {
          processNowCallCount++;
          if (processNowCallCount === 1) {
            return new Promise<[]>((resolve) => {
              resolveProcess = () => resolve([]);
            });
          }
          return Promise.resolve([]);
        }),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();

      // Start first processNow (will block on findAllActiveCronTriggers)
      const p1 = worker.processNow();

      // Allow microtask to enter the blocked state
      await new Promise((r) => setTimeout(r, 10));

      // Queue more calls while first is running — should coalesce into one re-run
      const p2 = worker.processNow();
      const p3 = worker.processNow();

      // Release the blocked call
      resolveProcess!();
      await Promise.all([p1, p2, p3]);

      // Should be 2: the first processNow + one coalesced re-run (not 3)
      expect(processNowCallCount).toBe(2);
    });
  });

  describe("stop", () => {
    it("stops processing after stop is called", async () => {
      const { worker, storage } = makeWorker();
      await worker.start();
      await worker.stop();
      await worker.processNow();
      expect(storage.findAllActiveCronTriggers).not.toHaveBeenCalled();
    });
  });

  describe("start", () => {
    it("does not need recovery — start is synchronous", async () => {
      const storage = makeStorage();
      const { worker } = makeWorker({ storage });
      await worker.start();
      // No storage calls on start — due-ness is computed on each processNow
      expect(storage.findAllActiveCronTriggers).not.toHaveBeenCalled();
    });
  });
});
