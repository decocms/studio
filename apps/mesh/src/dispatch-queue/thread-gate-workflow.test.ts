import { describe, expect, it } from "bun:test";
import {
  claimRunFenceForDispatch,
  resolveHarnessExecutionSite,
  setThreadGateRuntime,
  THREAD_GATE_PARTITION_CONCURRENCY,
  THREAD_GATE_QUEUE,
  type ThreadGateRuntime,
} from "./thread-gate-workflow";
import type { SerializableDispatchRunInput } from "./thread-gate-workflow";

describe("threadGateWorkflow plumbing", () => {
  it("exposes the queue name and per-thread concurrency cap", () => {
    expect(THREAD_GATE_QUEUE).toBe("thread-gate");
    // Concurrency=1 per partition (per thread) is what gives us
    // serialization — Phase 3 relies on this for "queue behavior".
    expect(THREAD_GATE_PARTITION_CONCURRENCY).toBe(1);
  });

  it("setThreadGateRuntime accepts a runtime shape", () => {
    const rt: ThreadGateRuntime = {
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

describe("claimRunFenceForDispatch", () => {
  const request = {
    taskId: "thread-1",
    messageId: "msg-1",
    runFenceToken: "submit-fence",
    organizationId: "org-1",
    userId: "user-1",
    models: {
      credentialId: "cred-1",
      thinking: { id: "model-1" },
    },
    agent: { id: "agent-1" },
    temperature: 0,
    toolApprovalLevel: "auto",
    mode: "default",
    target: { sandboxProviderKind: "agent-sandbox" },
    harnessId: "decopilot",
  } as SerializableDispatchRunInput;

  it("preserves the submit-time run fence token", () => {
    const claim = claimRunFenceForDispatch(request, () => "new-fence");

    expect(claim.runFenceToken).toBe("submit-fence");
    expect(claim.claimedRequest).toBe(request);
    expect(claim.shouldPersistFence).toBe(false);
  });

  it("mints and marks legacy requests for persistence when no submit fence exists", () => {
    const { runFenceToken: _ignored, ...legacyRequest } = request;
    const claim = claimRunFenceForDispatch(
      legacyRequest as SerializableDispatchRunInput,
      () => "legacy-fence",
    );

    expect(claim.runFenceToken).toBe("legacy-fence");
    expect(claim.claimedRequest.runFenceToken).toBe("legacy-fence");
    expect(claim.shouldPersistFence).toBe(true);
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
