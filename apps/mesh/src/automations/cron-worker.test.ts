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
    next_run_at: "2026-03-12T11:55:00Z",
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
  findDueCronTriggers: ReturnType<typeof mock>;
  updateTriggerNextRunAt: ReturnType<typeof mock>;
  tryAcquireRunSlot: ReturnType<typeof mock>;
  deactivateAutomation: ReturnType<typeof mock>;
  markRunFailed: ReturnType<typeof mock>;
}

function makeStorage(overrides?: Partial<MockStorage>): MockStorage {
  return {
    findDueCronTriggers: mock(() => Promise.resolve([])),
    updateTriggerNextRunAt: mock(() => Promise.resolve()),
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
  describe("processNow", () => {
    it("does nothing when not started", async () => {
      const { worker, storage } = makeWorker();
      // Don't call start()
      await worker.processNow();
      expect(storage.findDueCronTriggers).not.toHaveBeenCalled();
    });

    it("queries due triggers with current time", async () => {
      const { worker, storage } = makeWorker();
      await worker.start();
      await worker.processNow();
      // The second call is from processNow (first was from start/recover)
      const calls = (storage.findDueCronTriggers as any).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe(FIXED_NOW.toISOString());
    });

    it("fires automation for each due trigger", async () => {
      const trigger = makeTrigger();
      const automation = makeAutomation();
      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker, streamCoreFn } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      expect(streamCoreFn).toHaveBeenCalled();
    });

    it("schedules next run BEFORE firing automation", async () => {
      const callOrder: string[] = [];
      const trigger = makeTrigger({ cron_expression: "*/5 * * * *" });
      const automation = makeAutomation();

      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
        updateTriggerNextRunAt: mock(() => {
          callOrder.push("scheduleNext");
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

      expect(callOrder.indexOf("scheduleNext")).toBeLessThan(
        callOrder.indexOf("fire"),
      );
    });

    it("computes correct next_run_at from cron expression", async () => {
      const trigger = makeTrigger({ cron_expression: "0 * * * *" }); // every hour
      const automation = makeAutomation();

      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      // updateTriggerNextRunAt is called during recovery AND during processNow
      const calls = (storage.updateTriggerNextRunAt as any).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe("trig_1");
      // Next run should be a valid ISO date in the future
      const nextRun = new Date(lastCall[1]);
      expect(nextRun.getTime()).toBeGreaterThan(FIXED_NOW.getTime());
      expect(lastCall[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    });

    it("skips scheduling when trigger has no cron expression", async () => {
      const trigger = makeTrigger({ cron_expression: null });
      const automation = makeAutomation();

      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();

      // Reset mock after recovery phase
      (storage.updateTriggerNextRunAt as any).mockClear();

      await worker.processNow();
      expect(storage.updateTriggerNextRunAt).not.toHaveBeenCalled();
    });

    it("handles multiple due triggers in parallel", async () => {
      const t1 = makeTrigger({ id: "trig_1" });
      const t2 = makeTrigger({ id: "trig_2" });
      const a1 = makeAutomation({ id: "auto_1" });
      const a2 = makeAutomation({ id: "auto_2" });

      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
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
      const t1 = makeTrigger({ id: "trig_1" });
      const t2 = makeTrigger({ id: "trig_2" });
      const a1 = makeAutomation({ id: "auto_1" });
      const a2 = makeAutomation({ id: "auto_2" });

      let callCount = 0;
      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([
            { ...t1, automation: a1 },
            { ...t2, automation: a2 },
          ]),
        ),
        // First call fails (for scheduling), the rest succeed
        updateTriggerNextRunAt: mock(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error("db error"));
          }
          return Promise.resolve();
        }),
      });

      const { worker } = makeWorker({ storage });
      // start() will reset callCount via recovery, so just test processNow behavior
      await worker.start();
      callCount = 0; // Reset after recovery

      // Should not throw
      await worker.processNow();
    });
  });

  describe("coalescing", () => {
    it("coalesces concurrent processNow calls", async () => {
      let resolveProcess: (() => void) | undefined;
      // Track calls that use the processNow timestamp (not recovery)
      let processNowCallCount = 0;

      const storage = makeStorage({
        findDueCronTriggers: mock((timestamp: string) => {
          // Recovery uses a far-future date; processNow uses FIXED_NOW
          if (timestamp !== FIXED_NOW.toISOString()) {
            return Promise.resolve([]);
          }
          processNowCallCount++;
          if (processNowCallCount === 1) {
            // First processNow call blocks until we release
            return new Promise<[]>((resolve) => {
              resolveProcess = () => resolve([]);
            });
          }
          return Promise.resolve([]);
        }),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();

      // Start first processNow (will block on findDueCronTriggers)
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
      // Only the recovery call from start, no processNow call
      const calls = (storage.findDueCronTriggers as any).mock.calls;
      const processNowCalls = calls.filter(
        (c: any) => c[0] === FIXED_NOW.toISOString(),
      );
      expect(processNowCalls.length).toBe(0);
    });
  });

  describe("recovery (start)", () => {
    it("recomputes next_run_at for all cron triggers on start", async () => {
      const trigger = makeTrigger({
        id: "trig_recover",
        cron_expression: "0 0 * * *", // daily at midnight
        next_run_at: null, // stale
      });
      const automation = makeAutomation();

      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();

      const calls = (storage.updateTriggerNextRunAt as any).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const call = calls.find((c: any) => c[0] === "trig_recover");
      expect(call).toBeDefined();
      // Next daily midnight should be in the future
      const nextRun = new Date(call![1]);
      expect(nextRun.getTime()).toBeGreaterThan(FIXED_NOW.getTime());
    });

    it("skips triggers with invalid cron expressions during recovery", async () => {
      const trigger = makeTrigger({
        id: "trig_bad",
        cron_expression: "not a cron",
      });
      const automation = makeAutomation();

      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker } = makeWorker({ storage });
      // Should not throw
      await worker.start();
      // updateTriggerNextRunAt should not be called for this bad trigger
      expect(storage.updateTriggerNextRunAt).not.toHaveBeenCalled();
    });

    it("continues even if recovery query fails", async () => {
      const storage = makeStorage({
        findDueCronTriggers: mock(() => Promise.reject(new Error("db down"))),
      });

      const { worker } = makeWorker({ storage });
      // Should not throw — recovery errors are caught
      await worker.start();

      // Worker should still be running and processNow should work
      // (though findDueCronTriggers will fail again)
    });

    it("uses a far-future timestamp to fetch all triggers", async () => {
      const storage = makeStorage();
      const { worker } = makeWorker({ storage });
      await worker.start();

      const recoveryCall = (storage.findDueCronTriggers as any).mock.calls[0];
      const recoveryDate = new Date(recoveryCall[0]);
      // Should be roughly 1 year from now
      expect(recoveryDate.getTime()).toBeGreaterThan(
        FIXED_NOW.getTime() + 364 * 24 * 60 * 60 * 1000,
      );
    });
  });
});
