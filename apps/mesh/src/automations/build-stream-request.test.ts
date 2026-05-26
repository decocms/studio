import { describe, expect, it } from "bun:test";
import type { Automation } from "@/storage/types";
import {
  buildStreamRequest,
  type ResolvedAutomationModel,
} from "./build-stream-request";

function makeAutomation(overrides?: Partial<Automation>): Automation {
  return {
    id: "auto_1",
    organization_id: "org_1",
    name: "Test",
    active: true,
    created_by: "user_1",
    messages: JSON.stringify([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ]),
    models: JSON.stringify({ tier: "smart" }),
    temperature: 0.7,
    virtual_mcp_id: "agent_1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeResolvedModel(
  overrides?: Partial<ResolvedAutomationModel>,
): ResolvedAutomationModel {
  return {
    credentialId: "cred_live",
    thinking: {
      id: "model_live",
      title: "Live Model",
      provider: "anthropic",
      capabilities: { vision: true, file: true },
      limits: { contextWindow: 200_000, maxOutputTokens: 4096 },
    },
    ...overrides,
  };
}

describe("buildStreamRequest", () => {
  it("generates fresh message ids (not the stored ones)", () => {
    const result = buildStreamRequest(
      makeAutomation(),
      "trig_1",
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(msg.id).not.toBe("m1");
    expect(msg.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("places the resolved model in the request body", () => {
    const resolved = makeResolvedModel();
    const result = buildStreamRequest(
      makeAutomation(),
      null,
      "thrd_1",
      resolved,
    );
    expect(result.models.credentialId).toBe("cred_live");
    expect(result.models.thinking).toEqual(resolved.thinking);
  });

  it("sets organizationId from automation", () => {
    const result = buildStreamRequest(
      makeAutomation({ organization_id: "org_xyz" }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.organizationId).toBe("org_xyz");
  });

  it("sets userId from automation.created_by", () => {
    const result = buildStreamRequest(
      makeAutomation({ created_by: "user_abc" }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.userId).toBe("user_abc");
  });

  it("passes triggerId when provided", () => {
    const result = buildStreamRequest(
      makeAutomation(),
      "trig_99",
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.triggerId).toBe("trig_99");
  });

  it("sets triggerId to undefined when null", () => {
    const result = buildStreamRequest(
      makeAutomation(),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.triggerId).toBeUndefined();
  });

  it("passes taskId through", () => {
    const result = buildStreamRequest(
      makeAutomation(),
      null,
      "thrd_abc",
      makeResolvedModel(),
    );
    expect(result.taskId).toBe("thrd_abc");
  });

  it("uses automation temperature", () => {
    const result = buildStreamRequest(
      makeAutomation({ temperature: 0.9 }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.temperature).toBe(0.9);
  });

  it("defaults temperature to 0.5 when null", () => {
    const result = buildStreamRequest(
      makeAutomation({ temperature: null as any }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.temperature).toBe(0.5);
  });

  it("always sets toolApprovalLevel to auto", () => {
    const result = buildStreamRequest(
      makeAutomation(),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.toolApprovalLevel).toBe("auto");
  });

  it("always sets mode to default", () => {
    const result = buildStreamRequest(
      makeAutomation(),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.mode).toBe("default");
  });

  it("uses virtual_mcp_id as the agent id", () => {
    const automation = makeAutomation({ virtual_mcp_id: "vir_xyz" });
    const result = buildStreamRequest(
      automation,
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.agent).toEqual({ id: "vir_xyz" });
  });
});
