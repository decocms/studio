import { describe, expect, it } from "bun:test";
import { streamDecopilot } from "./index";
import type { HarnessStreamInput } from "../types";
import { setDecopilotRunContext } from "./run-context";

function makeInput(overrides: Partial<HarnessStreamInput>): HarnessStreamInput {
  const input: HarnessStreamInput = {
    threadId: "thread-1",
    userMessage: {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    },
    harness: {},
    workspace: { cwd: null },
    models: {
      thinking: {
        id: "claude-sonnet-4",
        title: "Claude Sonnet 4",
        credentialId: "cred-1",
      },
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
    agent: { id: "agent-1" },
    signal: new AbortController().signal,
    ...overrides,
  };
  setDecopilotRunContext(input, {
    taskId: "thread-1",
    virtualMcp: { id: "agent-1", metadata: {} },
  });
  return input;
}

describe("streamDecopilot", () => {
  it("returns a lazy stream without executing the run", () => {
    const stream = streamDecopilot({} as never, makeInput({}));
    expect(typeof stream[Symbol.asyncIterator]).toBe("function");
  });

  it("requires a resolved secret model source instead of an activated runtime provider", async () => {
    const iterator = streamDecopilot({} as never, makeInput({}))[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).rejects.toThrow(
      /secret thinking model source/,
    );
  });
});
