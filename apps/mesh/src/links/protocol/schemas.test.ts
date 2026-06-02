import { describe, expect, it } from "bun:test";
import {
  capabilitySchema,
  capabilitiesArraySchema,
  dispatchSSEEventSchema,
  harnessStreamInputSchema,
  type HarnessStreamInputWire,
} from "./schemas";

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

describe("capabilities", () => {
  it("includes body-offload", () => {
    expect(capabilitySchema.safeParse("body-offload").success).toBe(true);
  });
  it("drops unknown elements but keeps known ones (per-element tolerant)", () => {
    expect(
      capabilitiesArraySchema.parse(["claude-code", "made-up", "body-offload"]),
    ).toEqual(["claude-code", "body-offload"]);
  });
});
