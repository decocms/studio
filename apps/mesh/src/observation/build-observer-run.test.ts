import { describe, expect, test } from "bun:test";
import {
  buildObserverDispatchRequest,
  buildObserverSeed,
  toModelInfo,
} from "./build-observer-run";

const observedAgent = {
  id: "vir_observed",
  title: "Support Bot",
  description: "Handles customer support tickets",
  // Long instructions to exercise truncation (~1500 chars).
  instructions: "You are a helpful support agent. ".repeat(50),
};

describe("buildObserverSeed", () => {
  const seed = buildObserverSeed({
    observedAgent,
    sourceThread: { id: "thrd_1", title: "Refund question" },
    openingSnippet: "How do I get a refund for order 123?",
    messageCount: 6,
  });

  test("points the observer at the ids + read tools it needs", () => {
    expect(seed).toContain("thrd_1");
    expect(seed).toContain("vir_observed");
    expect(seed).toContain("COLLECTION_THREAD_MESSAGES_LIST");
    expect(seed).toContain("COLLECTION_VIRTUAL_MCP_GET");
  });

  test("includes the overview: agent name, message count, opening snippet", () => {
    expect(seed).toContain("Support Bot");
    expect(seed).toContain("6");
    expect(seed).toContain("How do I get a refund for order 123?");
  });

  test("truncates the observed agent's system prompt", () => {
    expect(seed).toContain("You are a helpful support agent.");
    // The full (untruncated) instructions must NOT all be present — only the
    // first MAX_INSTRUCTIONS_CHARS of them.
    expect(seed).not.toContain(observedAgent.instructions);
  });

  test("includes the loop-guard instruction", () => {
    expect(seed).toContain("Do not observe threads created by yourself");
  });

  test("is NEUTRAL — no use-case-specific behavior is baked in", () => {
    const lower = seed.toLowerCase();
    for (const word of [
      "memory",
      "moderation",
      "nsfw",
      "compliance",
      "summariz",
    ]) {
      expect(lower).not.toContain(word);
    }
  });

  test("omits the opening-message block when there is no snippet", () => {
    const s = buildObserverSeed({
      observedAgent,
      sourceThread: { id: "t", title: "x" },
      openingSnippet: null,
      messageCount: 0,
    });
    expect(s).not.toContain("Opening message");
  });
});

describe("buildObserverDispatchRequest", () => {
  const req = buildObserverDispatchRequest({
    observerThreadId: "thrd_obs",
    observerAgentId: "vir_obs",
    observerCreatedBy: "user_owner",
    organizationId: "org_1",
    models: {
      credentialId: "cred_1",
      thinking: toModelInfo({
        credentialId: "cred_1",
        modelId: "model-1",
        modelMeta: { title: "Model 1", capabilities: ["text"], limits: null },
      }),
    },
    seedText: "hello",
  });

  test("runs as the observer agent's owner (dispatch ownership invariant)", () => {
    expect(req.userId).toBe("user_owner");
  });

  test("targets the observer agent and the freshly-created observer thread", () => {
    expect(req.agent.id).toBe("vir_obs");
    expect(req.taskId).toBe("thrd_obs");
    expect(req.organizationId).toBe("org_1");
  });

  test("carries exactly one NON-system (user) seed message — dispatch requires it", () => {
    // dispatch-run.ts strips system messages and throws "No user message found"
    // if none remain. An all-system seed (the original bug) fails every run.
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.role).toBe("user");
    expect(req.messages.some((m) => m.role !== "system")).toBe(true);
  });

  test("uses default chat mode with auto tool approvals", () => {
    expect(req.mode).toBe("default");
    expect(req.toolApprovalLevel).toBe("auto");
  });
});
