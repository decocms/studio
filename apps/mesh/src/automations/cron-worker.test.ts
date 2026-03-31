import { describe, expect, it, mock } from "bun:test";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation, AutomationTrigger } from "@/storage/types";
import { AutomationCronWorker, type PublishFn } from "./cron-worker";

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
    virtual_mcp_id: null,
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
    next_run_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

interface MockStorage extends AutomationsStorage {
  findDueCronTriggers: ReturnType<typeof mock>;
  findAllCronTriggersForRecompute: ReturnType<typeof mock>;
  updateTriggerLastRunAt: ReturnType<typeof mock>;
  updateNextRunAt: ReturnType<typeof mock>;
  failZombieAutomationRuns: ReturnType<typeof mock>;
}

function makeStorage(overrides?: Partial<MockStorage>): MockStorage {
  return {
    findDueCronTriggers: mock(() => Promise.resolve([])),
    findAllActiveCronTriggers: mock(() => Promise.resolve([])),
    findAllCronTriggersForRecompute: mock(() => Promise.resolve([])),
    updateTriggerLastRunAt: mock(() => Promise.resolve()),
    updateNextRunAt: mock(() => Promise.resolve()),
    tryAcquireRunSlot: mock(() => Promise.resolve("thrd_1")),
    deactivateAutomation: mock(() => Promise.resolve()),
    markRunFailed: mock(() => Promise.resolve()),
    failZombieAutomationRuns: mock(() => Promise.resolve(0)),
    ...overrides,
  } as unknown as MockStorage;
}

function makeWorker(opts?: {
  storage?: MockStorage;
  publishJob?: ReturnType<typeof mock>;
  now?: () => Date;
}) {
  const storage = opts?.storage ?? makeStorage();
  const publishJob = opts?.publishJob ?? mock(() => Promise.resolve());

  const worker = new AutomationCronWorker(
    storage,
    publishJob as PublishFn,
    opts?.now ?? (() => FIXED_NOW),
  );

  return { worker, storage, publishJob };
}

// ============================================================================
// Tests
// ============================================================================

describe("AutomationCronWorker", () => {
  describe("isDue", () => {
    it("returns true when trigger has never run", () => {
      expect(AutomationCronWorker.isDue("*/5 * * * *", null, FIXED_NOW)).toBe(
        true,
      );
    });

    it("returns true when previous scheduled time is after last_run_at", () => {
      expect(
        AutomationCronWorker.isDue(
          "*/5 * * * *",
          "2026-03-12T11:50:00Z",
          FIXED_NOW,
        ),
      ).toBe(true);
    });

    it("returns false when next scheduled occurrence is still in the future", () => {
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

  describe("computeNextRunAt", () => {
    it("computes next run time from a given date", () => {
      const result = AutomationCronWorker.computeNextRunAt(
        "*/5 * * * *",
        new Date("2026-03-12T12:00:00Z"),
      );
      expect(result).toEqual(new Date("2026-03-12T12:05:00Z"));
    });

    it("returns null for invalid cron expression", () => {
      expect(
        AutomationCronWorker.computeNextRunAt("invalid", FIXED_NOW),
      ).toBeNull();
    });
  });

  describe("start", () => {
    it("recomputes stale next_run_at on startup", async () => {
      const trigger = makeTrigger({
        last_run_at: "2026-03-12T11:55:00Z",
        next_run_at: null,
      });
      const storage = makeStorage({
        findAllCronTriggersForRecompute: mock(() => Promise.resolve([trigger])),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();

      expect(storage.updateNextRunAt).toHaveBeenCalledWith(
        "trig_1",
        "2026-03-12T12:00:00.000Z",
      );
    });

    it("uses created_at when last_run_at is null", async () => {
      const trigger = makeTrigger({
        last_run_at: null,
        created_at: "2026-03-12T11:58:00Z",
      });
      const storage = makeStorage({
        findAllCronTriggersForRecompute: mock(() => Promise.resolve([trigger])),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();

      expect(storage.updateNextRunAt).toHaveBeenCalled();
    });
  });

  describe("processNow", () => {
    it("does nothing when not started", async () => {
      const { worker, storage } = makeWorker();
      await worker.processNow();
      expect(storage.findDueCronTriggers).not.toHaveBeenCalled();
    });

    it("queries due cron triggers", async () => {
      const { worker, storage } = makeWorker();
      await worker.start();
      await worker.processNow();
      expect(storage.findDueCronTriggers).toHaveBeenCalled();
    });

    it("dispatches due triggers to JetStream", async () => {
      const trigger = makeTrigger({ next_run_at: "2026-03-12T12:00:00Z" });
      const automation = makeAutomation();
      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker, publishJob } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      expect(publishJob).toHaveBeenCalledWith({
        triggerId: "trig_1",
        automationId: "auto_1",
        organizationId: ORG_ID,
      });
    });

    it("updates last_run_at BEFORE publishing to JetStream", async () => {
      const callOrder: string[] = [];
      const trigger = makeTrigger({ next_run_at: "2026-03-12T12:00:00Z" });
      const automation = makeAutomation();

      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
        updateTriggerLastRunAt: mock(() => {
          callOrder.push("updateLastRunAt");
          return Promise.resolve();
        }),
      });

      const publishJob = mock(() => {
        callOrder.push("publish");
        return Promise.resolve();
      });

      const { worker } = makeWorker({ storage, publishJob });
      await worker.start();
      await worker.processNow();

      expect(callOrder.indexOf("updateLastRunAt")).toBeLessThan(
        callOrder.indexOf("publish"),
      );
    });

    it("updates next_run_at after dispatching", async () => {
      const trigger = makeTrigger({
        cron_expression: "*/5 * * * *",
        next_run_at: "2026-03-12T12:00:00Z",
      });
      const automation = makeAutomation();
      const storage = makeStorage({
        findDueCronTriggers: mock(() =>
          Promise.resolve([{ ...trigger, automation }]),
        ),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      expect(storage.updateNextRunAt).toHaveBeenCalledWith(
        "trig_1",
        "2026-03-12T12:05:00.000Z",
      );
    });

    it("handles multiple due triggers in parallel", async () => {
      const t1 = makeTrigger({
        id: "trig_1",
        next_run_at: "2026-03-12T12:00:00Z",
      });
      const t2 = makeTrigger({
        id: "trig_2",
        next_run_at: "2026-03-12T12:00:00Z",
      });
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

      const { worker, publishJob } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      expect(publishJob.mock.calls.length).toBe(2);
    });

    it("does not crash when one trigger fails", async () => {
      const t1 = makeTrigger({
        id: "trig_1",
        next_run_at: "2026-03-12T12:00:00Z",
      });
      const t2 = makeTrigger({
        id: "trig_2",
        next_run_at: "2026-03-12T12:00:00Z",
      });
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
        findDueCronTriggers: mock(() => {
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

      const p1 = worker.processNow();
      await new Promise((r) => setTimeout(r, 10));

      const p2 = worker.processNow();
      const p3 = worker.processNow();

      resolveProcess!();
      await Promise.all([p1, p2, p3]);

      expect(processNowCallCount).toBe(2);
    });
  });

  describe("zombie run cleanup", () => {
    it("calls failZombieAutomationRuns before processing triggers", async () => {
      const callOrder: string[] = [];
      const storage = makeStorage({
        failZombieAutomationRuns: mock(() => {
          callOrder.push("zombieCleanup");
          return Promise.resolve(0);
        }),
        findDueCronTriggers: mock(() => {
          callOrder.push("findDueTriggers");
          return Promise.resolve([]);
        }),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      expect(storage.failZombieAutomationRuns).toHaveBeenCalled();
      expect(callOrder.indexOf("zombieCleanup")).toBeLessThan(
        callOrder.indexOf("findDueTriggers"),
      );
    });

    it("continues processing triggers when zombie cleanup fails", async () => {
      const storage = makeStorage({
        failZombieAutomationRuns: mock(() =>
          Promise.reject(new Error("db error")),
        ),
      });

      const { worker } = makeWorker({ storage });
      await worker.start();
      await worker.processNow();

      // Should still query for due triggers despite zombie cleanup failure
      expect(storage.findDueCronTriggers).toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("stops processing after stop is called", async () => {
      const { worker, storage } = makeWorker();
      await worker.start();
      await worker.stop();
      await worker.processNow();
      expect(storage.findDueCronTriggers).not.toHaveBeenCalled();
    });
  });
});
