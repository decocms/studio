import { describe, expect, it } from "bun:test";
import type { Automation } from "@/storage/types";
import {
  buildStreamRequest,
  contextMessageId,
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
    tools: null,
    temperature: 0.7,
    max_agent_steps: null,
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
  it("generates fresh message ids derived from taskId (not the stored ones)", () => {
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
    expect(msg.id).toBe("thrd_1:0");
  });

  it("generates the SAME message ids across repeated calls for the same taskId", () => {
    // buildDispatchRequestStep (the DBOS step wrapping this call) pre-persists
    // this message via PartEmitter before the step's own output is recorded.
    // A crash mid-step forces a full re-invocation with the same taskId — the
    // id must stay stable or the replay orphans a duplicate message row.
    const first = buildStreamRequest(
      makeAutomation(),
      "trig_1",
      "thrd_1",
      makeResolvedModel(),
    );
    const second = buildStreamRequest(
      makeAutomation(),
      "trig_1",
      "thrd_1",
      makeResolvedModel(),
    );
    expect(second.messages[0]!.id).toBe(first.messages[0]!.id);
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

  it("does not duplicate thread routing selectors in the dispatch request", () => {
    const automation = makeAutomation({ virtual_mcp_id: "vir_xyz" });
    const result = buildStreamRequest(
      automation,
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result).not.toHaveProperty("agent");
    expect(result).not.toHaveProperty("harnessId");
    expect(result).not.toHaveProperty("sandboxProviderKind");
  });

  it("leaves toolAllowlist null when automation.tools is null", () => {
    const result = buildStreamRequest(
      makeAutomation({ tools: null }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.toolAllowlist).toBeNull();
  });

  it("parses a stored tool allowlist", () => {
    const result = buildStreamRequest(
      makeAutomation({ tools: JSON.stringify(["web_search", "list_objects"]) }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.toolAllowlist).toEqual(["web_search", "list_objects"]);
  });

  it("treats an empty stored allowlist as null (= all tools)", () => {
    const result = buildStreamRequest(
      makeAutomation({ tools: JSON.stringify([]) }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.toolAllowlist).toBeNull();
  });

  it("falls back to null on a malformed allowlist", () => {
    const result = buildStreamRequest(
      makeAutomation({ tools: "{not json" }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.toolAllowlist).toBeNull();
  });

  it("leaves maxAgentSteps undefined when not configured", () => {
    const result = buildStreamRequest(
      makeAutomation({ max_agent_steps: null }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.maxAgentSteps).toBeUndefined();
  });

  it("forwards a configured maxAgentSteps", () => {
    const result = buildStreamRequest(
      makeAutomation({ max_agent_steps: 50 }),
      null,
      "thrd_1",
      makeResolvedModel(),
    );
    expect(result.maxAgentSteps).toBe(50);
  });
});

describe("contextMessageId", () => {
  it("is stable across repeated calls for the same taskId", () => {
    // buildDispatchRequestStep's fallback (no non-system message to prepend
    // event parts onto) uses this id for the synthetic message it pre-persists
    // via PartEmitter before its own step output is durably recorded — a
    // crash mid-step forces a full re-invocation, so a random id here would
    // orphan a duplicate message row the same way the fix in #4790 prevented
    // for the taskId-derived `${taskId}:${i}` ids above.
    expect(contextMessageId("thrd_1")).toBe(contextMessageId("thrd_1"));
  });

  it("never collides with a rawMessages index id", () => {
    expect(contextMessageId("thrd_1")).not.toMatch(/^thrd_1:\d+$/);
  });
});
