import { describe, expect, it } from "bun:test";
import {
  decideLinkDispatch,
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

describe("decideLinkDispatch (Transport Convergence)", () => {
  // EVERY user-desktop run goes through the link — all harnesses, both storage generations.
  it("routes a user-desktop claude-code target to the link", () => {
    expect(
      decideLinkDispatch({
        isLinkCapable: true,
        sandboxProviderKind: "user-desktop",
      }),
    ).toBe(true);
  });

  it("routes a user-desktop codex target to the link", () => {
    expect(
      decideLinkDispatch({
        isLinkCapable: true,
        sandboxProviderKind: "user-desktop",
      }),
    ).toBe(true);
  });

  it("routes a user-desktop decopilot target to the link", () => {
    // Decopilot desktop also runs in a sandbox, and the downstream work item
    // carries its sandbox config.
    expect(
      decideLinkDispatch({
        isLinkCapable: true,
        sandboxProviderKind: "user-desktop",
      }),
    ).toBe(true);
  });

  it("routes an agent-sandbox target to the hosted local-dispatch path", () => {
    expect(
      decideLinkDispatch({
        isLinkCapable: true,
        sandboxProviderKind: "agent-sandbox",
      }),
    ).toBe(false);
  });

  it("routes an undefined target (legacy path) to the hosted local-dispatch path", () => {
    expect(
      decideLinkDispatch({
        isLinkCapable: true,
        sandboxProviderKind: undefined,
      }),
    ).toBe(false);
  });

  it("does not use the link when the runtime is not link-capable", () => {
    expect(
      decideLinkDispatch({
        isLinkCapable: false,
        sandboxProviderKind: "user-desktop",
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

  it("never times out when uncapped (Infinity) and returns once terminal", async () => {
    let i = 0;
    // Stays in_progress for many polls, then goes terminal — must NOT throw.
    const fetch = async (): Promise<string> =>
      i++ < 50 ? "in_progress" : "completed";
    const result = await pollUntilTerminal(fetch, {
      intervalMs: 0,
      maxAttempts: Number.POSITIVE_INFINITY,
    });
    expect(result).toBe("completed");
    expect(i).toBe(51);
  });

  it("uncapped still honors the abort signal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetch = async () => {
      calls++;
      if (calls === 3) controller.abort();
      return "in_progress" as const;
    };
    await expect(
      pollUntilTerminal(fetch, {
        intervalMs: 0,
        maxAttempts: Number.POSITIVE_INFINITY,
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
