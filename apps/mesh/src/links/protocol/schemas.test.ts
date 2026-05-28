import { describe, expect, it } from "bun:test";
import {
  capabilitySchema,
  dispatchSSEEventSchema,
  harnessStreamInputSchema,
  type HarnessStreamInputWire,
  linkEntrySchema,
} from "./schemas";

describe("linkEntrySchema", () => {
  it("preserves linkSecret as opaque string", () => {
    const payload = {
      machineId: "m-1",
      tunnelUrl: "https://tunnel.example.com",
      linkSecret: "OPAQUE-SECRET-STRING",
      cliVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["claude-code" as const],
      createdAt: "2026-05-19T00:00:00.000Z",
    };
    const result = linkEntrySchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.linkSecret).toBe("OPAQUE-SECRET-STRING");
    }
  });
});

describe("dispatchSSEEventSchema", () => {
  it("accepts ui-message-chunk", () => {
    const result = dispatchSSEEventSchema.safeParse({
      type: "ui-message-chunk",
      chunk: { hello: "world" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts error", () => {
    const result = dispatchSSEEventSchema.safeParse({
      type: "error",
      code: "harness_crashed",
      message: "boom",
    });
    expect(result.success).toBe(true);
  });

  it("accepts done", () => {
    const result = dispatchSSEEventSchema.safeParse({ type: "done" });
    expect(result.success).toBe(true);
  });
});

describe("harnessStreamInputSchema", () => {
  const minimalInput: HarnessStreamInputWire = {
    threadId: "thr-1",
    runId: "run-1",
    taskId: "thr-1",
    messages: [],
    models: {
      credentialId: "cred-1",
      thinking: { id: "claude-code:opus", title: "Opus" },
    },
    mcp: {
      url: "https://mesh.example.com/mcp/virtual-mcp/agent-1",
      headers: { Authorization: "Bearer fixture" },
      expiresAt: 9999999999000,
    },
    mode: "default",
    temperature: 0.7,
    toolApprovalLevel: "auto",
    user: { id: "user-1", email: "user@example.com" },
    organizationId: "org-1",
    virtualMcp: { id: "agent-1" },
    agent: { id: "agent-1" },
  };

  it("round-trips a minimal CLI harness input", () => {
    const result = harnessStreamInputSchema.safeParse(minimalInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.threadId).toBe("thr-1");
      expect(result.data.models.thinking.title).toBe("Opus");
    }
  });

  it("strips signal and processLocal fields", () => {
    const withExtras = {
      ...minimalInput,
      signal: { aborted: false },
      processLocal: true,
    };
    const result = harnessStreamInputSchema.safeParse(withExtras);
    expect(result.success).toBe(true);
    if (result.success) {
      expect("signal" in result.data).toBe(false);
      expect("processLocal" in result.data).toBe(false);
    }
  });
});

describe("capabilitySchema", () => {
  it("accepts known harnesses", () => {
    expect(capabilitySchema.safeParse("claude-code").success).toBe(true);
    expect(capabilitySchema.safeParse("codex").success).toBe(true);
    expect(capabilitySchema.safeParse("decopilot-sandbox").success).toBe(true);
  });

  it("rejects unknown harness", () => {
    expect(capabilitySchema.safeParse("not-a-harness").success).toBe(false);
  });
});
