import { describe, expect, it } from "bun:test";
import type { Automation } from "@/storage/types";
import { buildStreamRequest, type TierOverride } from "./build-stream-request";

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
    models: JSON.stringify({
      thinking: { id: "gpt-4", title: "GPT-4" },
      credentialId: "cred_1",
    }),
    temperature: 0.7,
    virtual_mcp_id: "agent_1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildStreamRequest", () => {
  it("parses JSON columns into objects", () => {
    const result = buildStreamRequest(makeAutomation(), "trig_1", "thrd_1");
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.parts).toEqual([{ type: "text", text: "hello" }]);
    // Message id should be a fresh UUID, not the stored one
    expect(msg.id).not.toBe("m1");
    expect(msg.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.models).toEqual({
      thinking: { id: "gpt-4", title: "GPT-4" },
      credentialId: "cred_1",
    });
    expect(result.agent).toEqual({ id: "agent_1" });
  });

  it("sets organizationId from automation", () => {
    const result = buildStreamRequest(
      makeAutomation({ organization_id: "org_xyz" }),
      null,
      "thrd_1",
    );
    expect(result.organizationId).toBe("org_xyz");
  });

  it("sets userId from automation.created_by", () => {
    const result = buildStreamRequest(
      makeAutomation({ created_by: "user_abc" }),
      null,
      "thrd_1",
    );
    expect(result.userId).toBe("user_abc");
  });

  it("passes triggerId when provided", () => {
    const result = buildStreamRequest(makeAutomation(), "trig_99", "thrd_1");
    expect(result.triggerId).toBe("trig_99");
  });

  it("sets triggerId to undefined when null", () => {
    const result = buildStreamRequest(makeAutomation(), null, "thrd_1");
    expect(result.triggerId).toBeUndefined();
  });

  it("passes taskId through", () => {
    const result = buildStreamRequest(makeAutomation(), null, "thrd_abc");
    expect(result.taskId).toBe("thrd_abc");
  });

  it("uses automation temperature", () => {
    const result = buildStreamRequest(
      makeAutomation({ temperature: 0.9 }),
      null,
      "thrd_1",
    );
    expect(result.temperature).toBe(0.9);
  });

  it("defaults temperature to 0.5 when null", () => {
    const result = buildStreamRequest(
      makeAutomation({ temperature: null as any }),
      null,
      "thrd_1",
    );
    expect(result.temperature).toBe(0.5);
  });

  it("always sets toolApprovalLevel to auto", () => {
    const result = buildStreamRequest(makeAutomation(), null, "thrd_1");
    expect(result.toolApprovalLevel).toBe("auto");
  });

  it("always sets mode to default", () => {
    const result = buildStreamRequest(makeAutomation(), null, "thrd_1");
    expect(result.mode).toBe("default");
  });

  it("uses virtual_mcp_id as the agent id", () => {
    const automation = makeAutomation({ virtual_mcp_id: "vir_xyz" });
    const result = buildStreamRequest(automation, null, "thrd_1");
    expect(result.agent).toEqual({ id: "vir_xyz" });
  });

  describe("tier override", () => {
    const override: TierOverride = {
      credentialId: "cred_live",
      thinking: {
        id: "model_live",
        title: "Live Model",
        provider: "anthropic",
        capabilities: { vision: true, file: true },
        limits: { contextWindow: 200_000, maxOutputTokens: 4096 },
      },
    };

    it("replaces credential and the entire thinking field", () => {
      const automation = makeAutomation({
        models: JSON.stringify({
          credentialId: "cred_stale",
          thinking: {
            id: "model_stale",
            title: "Stale",
            capabilities: { vision: false, file: false },
            limits: { contextWindow: 8000, maxOutputTokens: 1024 },
          },
          tier: "smart",
        }),
      });
      const result = buildStreamRequest(automation, null, "thrd_1", override);
      expect(result.models.credentialId).toBe("cred_live");
      expect(result.models.thinking).toEqual(override.thinking);
    });

    it("falls back to snapshot when no override is supplied", () => {
      const automation = makeAutomation({
        models: JSON.stringify({
          credentialId: "cred_snapshot",
          thinking: { id: "model_snapshot" },
          tier: "smart",
        }),
      });
      const result = buildStreamRequest(automation, null, "thrd_1", null);
      expect(result.models.credentialId).toBe("cred_snapshot");
      expect((result.models.thinking as { id: string }).id).toBe(
        "model_snapshot",
      );
    });

    it("leaves snapshot intact when override is undefined", () => {
      const automation = makeAutomation();
      const result = buildStreamRequest(automation, null, "thrd_1");
      expect(result.models.credentialId).toBe("cred_1");
    });
  });
});
