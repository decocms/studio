import { describe, expect, it } from "bun:test";
import {
  decidePullDispatch,
  pollUntilTerminal,
  setThreadGateRuntime,
  TERMINAL_STATUSES,
  THREAD_GATE_PARTITION_CONCURRENCY,
  THREAD_GATE_QUEUE,
  type ThreadGateRuntime,
} from "./thread-gate-workflow";

describe("threadGateWorkflow plumbing", () => {
  it("exposes the queue name and per-thread concurrency cap", () => {
    expect(THREAD_GATE_QUEUE).toBe("thread-gate");
    // Concurrency=1 per partition (per thread) is what gives us
    // serialization — Phase 3 relies on this for "queue behavior".
    expect(THREAD_GATE_PARTITION_CONCURRENCY).toBe(1);
  });

  it("setThreadGateRuntime accepts a runtime shape", () => {
    const rt: ThreadGateRuntime = {
      dispatchRunFn: async () => ({ taskId: "t" }),
      meshContextFactory: async () => null,
      deps: {
        runRegistry: {} as ThreadGateRuntime["deps"]["runRegistry"],
        cancelBroadcast: {} as ThreadGateRuntime["deps"]["cancelBroadcast"],
        streamBuffer: undefined,
      },
    };
    expect(() => setThreadGateRuntime(rt)).not.toThrow();
  });
});

describe("decidePullDispatch (Phase C-bis S6 target-gate)", () => {
  it("routes a user-desktop target on a v2 thread to pull", () => {
    expect(
      decidePullDispatch({
        isPullCapable: true,
        targetRunsIn: "user-desktop",
        messageStorageVersion: 2,
      }),
    ).toBe(true);
  });

  it("routes a cluster target to the in-cluster ws path (NOT pull)", () => {
    // The reverted cutover (40562b383) wrongly sent these to pull. Cloud /
    // cluster threads have no desktop daemon to drain the work queue.
    expect(
      decidePullDispatch({
        isPullCapable: true,
        targetRunsIn: "cluster",
        messageStorageVersion: 2,
      }),
    ).toBe(false);
  });

  it("routes an undefined target (legacy path) to the in-cluster ws path", () => {
    expect(
      decidePullDispatch({
        isPullCapable: true,
        targetRunsIn: undefined,
        messageStorageVersion: 2,
      }),
    ).toBe(false);
  });

  it("routes a user-desktop target on a v1 thread to the ws path (v2 conjunct)", () => {
    // Belt-and-suspenders: a v1 user-desktop thread has no v2 ingest path, so
    // pull would silently corrupt. The version conjunct forces ws fallback.
    expect(
      decidePullDispatch({
        isPullCapable: true,
        targetRunsIn: "user-desktop",
        messageStorageVersion: 1,
      }),
    ).toBe(false);
  });

  it("never pulls when the runtime is not pull-capable (no NATS work queue)", () => {
    expect(
      decidePullDispatch({
        isPullCapable: false,
        targetRunsIn: "user-desktop",
        messageStorageVersion: 2,
      }),
    ).toBe(false);
  });

  it("treats a null/undefined message_storage_version as non-v2 (ws path)", () => {
    expect(
      decidePullDispatch({
        isPullCapable: true,
        targetRunsIn: "user-desktop",
        messageStorageVersion: null,
      }),
    ).toBe(false);
    expect(
      decidePullDispatch({
        isPullCapable: true,
        targetRunsIn: "user-desktop",
        messageStorageVersion: undefined,
      }),
    ).toBe(false);
  });
});

describe("pollUntilTerminal", () => {
  it("returns immediately when status is already terminal", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return "completed" as const;
    };
    const result = await pollUntilTerminal(fetch, {
      intervalMs: 0,
      maxAttempts: 10,
    });
    expect(result).toBe("completed");
    expect(calls).toBe(1);
  });

  it("retries until terminal and returns the status", async () => {
    const statuses: string[] = ["in_progress", "in_progress", "failed"];
    let i = 0;
    const fetch = async (): Promise<string> =>
      statuses[Math.min(i++, statuses.length - 1)] as string;
    const result = await pollUntilTerminal(fetch, {
      intervalMs: 0,
      maxAttempts: 10,
    });
    expect(result).toBe("failed");
    expect(i).toBe(3);
  });

  it("throws after maxAttempts with no terminal status", async () => {
    const fetch = async () => "in_progress" as const;
    await expect(
      pollUntilTerminal(fetch, { intervalMs: 0, maxAttempts: 3 }),
    ).rejects.toThrow("gate timed out");
  });

  it("aborts early on abort signal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetch = async () => {
      calls++;
      if (calls === 2) controller.abort();
      return "in_progress" as const;
    };
    await expect(
      pollUntilTerminal(fetch, {
        intervalMs: 0,
        maxAttempts: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe("TERMINAL_STATUSES", () => {
  it("contains completed, failed, requires_action", () => {
    expect(TERMINAL_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_STATUSES.has("failed")).toBe(true);
    expect(TERMINAL_STATUSES.has("requires_action")).toBe(true);
    // "in_progress" is not a member of the terminal set
    const statuses = TERMINAL_STATUSES as Set<string>;
    expect(statuses.has("in_progress")).toBe(false);
  });
});
