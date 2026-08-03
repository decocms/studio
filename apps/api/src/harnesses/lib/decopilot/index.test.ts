import { describe, expect, it } from "bun:test";
import { streamDecopilot } from "./index";
import type { DecopilotStreamInput } from "../types";
import type { DecopilotRunContext } from "./run-context";

const RUN_CONTEXT: DecopilotRunContext = {
  virtualMcp: { id: "agent-1", metadata: {} },
};

function makeInput(
  overrides: Partial<DecopilotStreamInput>,
): DecopilotStreamInput {
  return {
    threadId: "thread-1",
    userMessage: {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    },
    models: {
      thinking: {
        id: "claude-sonnet-4",
        title: "Claude Sonnet 4",
        credentialId: "cred-1",
      },
    },
    mode: "default",
    temperature: 0.5,
    toolApprovalLevel: "auto",
    user: { id: "user-1", email: "user@example.com" },
    organizationId: "org-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("streamDecopilot", () => {
  it("returns a lazy stream without executing the run", () => {
    const stream = streamDecopilot({} as never, makeInput({}), RUN_CONTEXT);
    expect(typeof stream[Symbol.asyncIterator]).toBe("function");
  });

  it("requires a resolved secret model source instead of an activated runtime provider", async () => {
    const iterator = streamDecopilot({} as never, makeInput({}), RUN_CONTEXT)[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).rejects.toThrow(
      /secret thinking model source/,
    );
  });
});
