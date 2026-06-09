import { describe, expect, it } from "bun:test";
import { decopilotHarnessFactory } from "./index";
import type { HarnessStreamInput } from "../types";

function makeInput(overrides: Partial<HarnessStreamInput>): HarnessStreamInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [],
    models: {
      credentialId: "cred-1",
      thinking: { id: "claude-sonnet-4", title: "Claude Sonnet 4" },
    },
    mcp: {
      url: "https://studio.example.com/mcp/agent-1",
      headers: { Authorization: "Bearer token" },
      expiresAt: 9999999999000,
    },
    mode: "default",
    temperature: 0.5,
    toolApprovalLevel: "auto",
    user: { id: "user-1", email: "user@example.com" },
    organizationId: "org-1",
    virtualMcp: { id: "agent-1", metadata: {}, connections: [] },
    agent: { id: "agent-1" },
    signal: new AbortController().signal,
    taskId: "thread-1",
    ...overrides,
  };
}

describe("decopilotHarnessFactory", () => {
  it("requires a resolved secret model source instead of an activated runtime provider", async () => {
    const harness = decopilotHarnessFactory.create({} as never);
    const iterator = harness.stream(makeInput({}))[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(/secret modelSource/);
  });
});
