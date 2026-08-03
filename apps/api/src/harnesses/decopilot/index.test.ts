import { describe, expect, it } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk";
import { streamDecopilot } from "./index";
import type { DecopilotStreamInput } from "@/harnesses/lib/types";
import type { DecopilotRunContext } from "@/harnesses/lib/decopilot/run-context";

const RUN_CONTEXT: DecopilotRunContext = {
  virtualMcp: { id: "agent-1", metadata: {} } as VirtualMCPEntity,
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

  it("builds the hosted environment directly from StudioContext", async () => {
    const runContext: DecopilotRunContext = {
      ...RUN_CONTEXT,
      modelSources: {
        thinking: {
          kind: "secret",
          providerId: "anthropic",
          apiKey: "test-key",
          modelId: "claude-test",
        },
      },
    };
    const iterator = streamDecopilot({} as never, makeInput({}), runContext)[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).rejects.toThrow(
      /organization context is required/,
    );
  });
});
