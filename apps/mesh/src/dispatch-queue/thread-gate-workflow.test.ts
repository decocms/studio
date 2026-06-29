import { describe, expect, it } from "bun:test";
import {
  pollUntilTerminal,
  resolveHarnessExecutionSite,
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

describe("resolveHarnessExecutionSite (topology tuple → site)", () => {
  it("runs a (claude-code, user-desktop) loop on the sandbox", () => {
    expect(
      resolveHarnessExecutionSite({
        isLinkCapable: true,
        sandboxProviderKind: "user-desktop",
        harnessId: "claude-code",
      }),
    ).toBe("sandbox");
  });

  it("runs a (codex, user-desktop) loop on the sandbox", () => {
    expect(
      resolveHarnessExecutionSite({
        isLinkCapable: true,
        sandboxProviderKind: "user-desktop",
        harnessId: "codex",
      }),
    ).toBe("sandbox");
  });

  it("keeps decopilot on the cluster even for user-desktop targets", () => {
    // Decopilot always runs its agent loop in the cluster; tool calls reach
    // the desktop via the NATS downlink inside the virtual MCP passthrough.
    expect(
      resolveHarnessExecutionSite({
        isLinkCapable: true,
        sandboxProviderKind: "user-desktop",
        harnessId: "decopilot",
      }),
    ).toBe("cluster");
  });

  it("runs a legacy/undefined-harness agent-sandbox target on the cluster", () => {
    expect(
      resolveHarnessExecutionSite({
        isLinkCapable: true,
        sandboxProviderKind: "agent-sandbox",
      }),
    ).toBe("cluster");
  });

  it("throws for a CLI harness on an agent-sandbox (cloud-CLI not implemented)", () => {
    for (const harnessId of ["claude-code", "codex"]) {
      expect(() =>
        resolveHarnessExecutionSite({
          isLinkCapable: true,
          sandboxProviderKind: "agent-sandbox",
          harnessId,
        }),
      ).toThrow(/not implemented/);
    }
  });

  it("keeps decopilot on an agent-sandbox on the cluster", () => {
    expect(
      resolveHarnessExecutionSite({
        isLinkCapable: true,
        sandboxProviderKind: "agent-sandbox",
        harnessId: "decopilot",
      }),
    ).toBe("cluster");
  });

  it("runs an undefined target (legacy path) on the cluster", () => {
    expect(
      resolveHarnessExecutionSite({
        isLinkCapable: true,
        sandboxProviderKind: undefined,
      }),
    ).toBe("cluster");
  });

  it("falls back to the cluster when the runtime is not link-capable", () => {
    expect(
      resolveHarnessExecutionSite({
        isLinkCapable: false,
        sandboxProviderKind: "user-desktop",
      }),
    ).toBe("cluster");
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
