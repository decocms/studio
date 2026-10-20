import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { liveRunSandbox } from "./live-messages";

function ctxWithAgentOrg(organizationId: string): StudioContext {
  return {
    storage: {
      virtualMcps: {
        findById: async () => ({
          id: "agent_1",
          organization_id: organizationId,
          metadata: null,
        }),
      },
    },
  } as unknown as StudioContext;
}

describe("liveRunSandbox", () => {
  test("never resolves a sandbox for an agent owned by another org", async () => {
    const ctx = ctxWithAgentOrg("org_other");
    const handle = await liveRunSandbox(ctx, {
      threadId: "thrd_1",
      agentId: "agent_1",
      runBranch: "main",
      organizationId: "org_mine",
    });
    expect(handle).toBeNull();
  });
});
