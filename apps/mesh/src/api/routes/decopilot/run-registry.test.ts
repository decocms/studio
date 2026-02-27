import { describe, it, expect, mock } from "bun:test";
import type { ThreadStoragePort } from "@/storage/ports";
import { RunRegistry } from "./run-registry";

function mockStorage(): ThreadStoragePort {
  return {
    update: mock(() => Promise.resolve({} as never)),
    create: mock(() => Promise.resolve({} as never)),
    get: mock(() => Promise.resolve(null)),
    delete: mock(() => Promise.resolve()),
    list: mock(() => Promise.resolve({ threads: [], total: 0 })),
    saveMessages: mock(() => Promise.resolve()),
    listMessages: mock(() => Promise.resolve({ messages: [], total: 0 })),
  };
}

describe("RunRegistry", () => {
  function createRegistry() {
    return new RunRegistry();
  }

  describe("startRun", () => {
    it("creates a new run with correct fields and running status", () => {
      const registry = createRegistry();
      const run = registry.startRun("t1", "org1", "u1");

      expect(run.threadId).toBe("t1");
      expect(run.orgId).toBe("org1");
      expect(run.userId).toBe("u1");
      expect(run.status).toBe("running");
      expect(run.abortController).toBeInstanceOf(AbortController);
      expect(run.abortController.signal.aborted).toBe(false);
      expect(run.startedAt).toBeInstanceOf(Date);
    });

    it("aborts and replaces an existing running entry for the same threadId", () => {
      const registry = createRegistry();
      const first = registry.startRun("t1", "org1", "u1");
      const firstAbort = first.abortController;

      const second = registry.startRun("t1", "org2", "u2");

      expect(firstAbort.signal.aborted).toBe(true);
      expect(first.status).toBe("failed");
      expect(second.threadId).toBe("t1");
      expect(second.orgId).toBe("org2");
      expect(second.status).toBe("running");
      expect(registry.getRun("t1")).toBe(second);
    });

    it("replaces a non-running entry without aborting", () => {
      const registry = createRegistry();
      const first = registry.startRun("t1", "org1", "u1");
      registry.completeRun("t1", "completed");
      const firstAbort = first.abortController;

      registry.startRun("t1", "org1", "u1");

      expect(firstAbort.signal.aborted).toBe(false);
    });
  });

  describe("getRun", () => {
    it("returns the run for an existing threadId", () => {
      const registry = createRegistry();
      const run = registry.startRun("t1", "org1", "u1");
      expect(registry.getRun("t1")).toBe(run);
    });

    it("returns undefined for a non-existent threadId", () => {
      const registry = createRegistry();
      expect(registry.getRun("nope")).toBeUndefined();
    });
  });

  describe("cancelLocal", () => {
    it("returns true and aborts a running entry", () => {
      const registry = createRegistry();
      const run = registry.startRun("t1", "org1", "u1");
      const result = registry.cancelLocal("t1");

      expect(result).toBe(true);
      expect(run.status).toBe("failed");
      expect(run.abortController.signal.aborted).toBe(true);
    });

    it("returns false for a non-existent threadId", () => {
      const registry = createRegistry();
      expect(registry.cancelLocal("nope")).toBe(false);
    });

    it("returns false for a non-running entry", () => {
      const registry = createRegistry();
      registry.startRun("t1", "org1", "u1");
      registry.completeRun("t1", "completed");

      expect(registry.cancelLocal("t1")).toBe(false);
    });
  });

  describe("completeRun", () => {
    it("sets status and deletes from the map", () => {
      const registry = createRegistry();
      const run = registry.startRun("t1", "org1", "u1");
      registry.completeRun("t1", "completed");

      expect(run.status).toBe("completed");
      expect(registry.getRun("t1")).toBeUndefined();
    });

    it("is a no-op for a non-existent threadId", () => {
      const registry = createRegistry();
      registry.completeRun("no-such-thread", "failed");
      expect(registry.getRun("no-such-thread")).toBeUndefined();
    });
  });

  describe("finishRun", () => {
    it("calls completeRun and invokes onPurge callback", () => {
      const registry = createRegistry();
      registry.startRun("t1", "org1", "u1");
      const purged: string[] = [];

      registry.finishRun("t1", "completed", (id) => purged.push(id));

      expect(registry.getRun("t1")).toBeUndefined();
      expect(purged).toEqual(["t1"]);
    });

    it("works without onPurge callback", () => {
      const registry = createRegistry();
      const run = registry.startRun("t1", "org1", "u1");
      registry.finishRun("t1", "failed");

      expect(run.status).toBe("failed");
      expect(registry.getRun("t1")).toBeUndefined();
    });

    it("is a no-op for non-existent threadId (no throw)", () => {
      const registry = createRegistry();
      const purged: string[] = [];
      registry.finishRun("no-such-thread", "failed", (id) => purged.push(id));
      expect(purged).toEqual(["no-such-thread"]);
    });
  });

  describe("stopAll", () => {
    it("aborts all running entries and clears the map", () => {
      const registry = createRegistry();
      const storage = mockStorage();
      const run1 = registry.startRun("t1", "org1", "u1");
      const run2 = registry.startRun("t2", "org1", "u2");

      const completedRun = registry.startRun("t3", "org1", "u3");
      completedRun.status = "completed" as const;

      registry.stopAll(storage);

      expect(run1.abortController.signal.aborted).toBe(true);
      expect(run2.abortController.signal.aborted).toBe(true);
      expect(completedRun.abortController.signal.aborted).toBe(false);

      expect(storage.update).toHaveBeenCalledTimes(2);
      expect(storage.update).toHaveBeenCalledWith("t1", { status: "failed" });
      expect(storage.update).toHaveBeenCalledWith("t2", { status: "failed" });

      expect(registry.getRun("t1")).toBeUndefined();
      expect(registry.getRun("t2")).toBeUndefined();
      expect(registry.getRun("t3")).toBeUndefined();
    });
  });
});
