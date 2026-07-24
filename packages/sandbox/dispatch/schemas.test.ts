import { describe, expect, it, test } from "bun:test";
import {
  capabilitySchema,
  capabilitiesArraySchema,
  dispatchSSEEventSchema,
  harnessStreamInputSchema,
  type HarnessStreamInputWire,
} from "./schemas";
import { FIXTURE_MINIMAL_INPUT } from "./fixtures";

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

describe("harnessStreamInputSchema (v3)", () => {
  test("accepts v3 single-message harness input", () => {
    const result = harnessStreamInputSchema.safeParse({
      harnessId: "claude-code",
      threadId: "thread-1",
      userMessage: {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "diagnose" }],
      },
      harness: { sessionId: "cli-session-1" },
      workspace: {
        cwd: "/repo",
        repo: { owner: "deco", name: "site", connectedGithub: true },
        branch: "main",
      },
      models: {
        thinking: {
          id: "claude-code:opus",
          title: "Opus",
          credentialId: "cred-1",
        },
      },
      mcp: {
        url: "https://studio.example.com/mcp/virtual-mcp/agent-1",
        headers: { Authorization: "Bearer token" },
        expiresAt: 9999999999000,
      },
      mode: "default",
      temperature: 0.7,
      toolApprovalLevel: "auto",
      user: { id: "user-1", email: "u@example.com" },
      organizationId: "org-1",
      organizationSlug: "acme",
      agent: { id: "agent-1", instructions: "Help carefully." },
    });

    expect(result.success).toBe(true);
  });

  test.each([
    ["runId", "run-1"],
    ["taskId", "task-1"],
    ["resumeSessionRef", "old-session"],
    ["messages", []],
    [
      "codingWorkspace",
      { cwd: "/repo", branch: "main", workspaceKind: "github" },
    ],
    ["projectSlug", "legacy"],
    ["virtualMcp", { id: "agent-1" }],
  ] as const)("rejects removed shared harness field %s", (field, value) => {
    const result = harnessStreamInputSchema.safeParse({
      ...FIXTURE_MINIMAL_INPUT,
      [field]: value,
    });

    expect(result.success).toBe(false);
  });

  test.each([
    ["user", { id: "user-fixture", email: "fixture@example.com", admin: true }],
    ["agent", { id: "agent-fixture", metadata: {} }],
  ] as const)("rejects unknown nested keys on %s", (field, value) => {
    const result = harnessStreamInputSchema.safeParse({
      ...FIXTURE_MINIMAL_INPUT,
      [field]: value,
    });

    expect(result.success).toBe(false);
  });

  const minimalV3: HarnessStreamInputWire = FIXTURE_MINIMAL_INPUT;

  it("accepts a minimal v3 input", () => {
    const result = harnessStreamInputSchema.safeParse(minimalV3);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.threadId).toBe("thr-fixture");
      expect(result.data.userMessage.id).toBe("msg-fixture");
      expect(result.data.harness).toEqual({});
      expect(result.data.workspace).toEqual({ cwd: null });
      expect(result.data.models.thinking.credentialId).toBe("cred-fixture");
    }
  });

  it("rejects the old v1 shape (no workspace, root credentialId, modelSources.primary)", () => {
    const v1Input = {
      threadId: "thr-1",
      runId: "run-1",
      taskId: "thr-1",
      messages: [],
      models: {
        credentialId: "cred-1",
        thinking: { id: "claude-code:opus", title: "Opus" },
      },
      modelSources: {
        primary: {
          kind: "secret",
          providerId: "anthropic",
          apiKey: "sk-main",
          modelId: "claude-sonnet-4",
        },
      },
      mcp: {
        url: "https://studio.example.com/mcp/virtual-mcp/agent-1",
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

    expect(harnessStreamInputSchema.safeParse(v1Input).success).toBe(false);
  });

  it("round-trips all five model slots with per-slot credentialId and harnessId", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      harnessId: "decopilot",
      models: {
        thinking: {
          id: "anthropic/claude-sonnet",
          title: "Sonnet",
          provider: null,
          credentialId: "cred-chat",
          limits: { contextWindow: 200000, maxOutputTokens: 32768 },
          capabilities: { reasoning: true, vision: true, text: true },
        },
        fast: {
          id: "anthropic/claude-haiku",
          title: "Haiku",
          credentialId: "cred-chat",
        },
        smart: {
          id: "anthropic/claude-opus",
          title: "Opus",
          credentialId: "cred-chat",
        },
        image: {
          id: "google/imagen",
          title: "Imagen",
          provider: "google",
          credentialId: "cred-image",
          limits: { maxOutputTokens: 4096 },
        },
        deepResearch: {
          id: "google/gemini-deep-research",
          title: "Deep Research",
          provider: "google",
          credentialId: "cred-research",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.harnessId).toBe("decopilot");
      expect(result.data.models).toEqual({
        thinking: {
          id: "anthropic/claude-sonnet",
          title: "Sonnet",
          provider: null,
          credentialId: "cred-chat",
          limits: { contextWindow: 200000, maxOutputTokens: 32768 },
          capabilities: { reasoning: true, vision: true, text: true },
        },
        fast: {
          id: "anthropic/claude-haiku",
          title: "Haiku",
          credentialId: "cred-chat",
        },
        smart: {
          id: "anthropic/claude-opus",
          title: "Opus",
          credentialId: "cred-chat",
        },
        image: {
          id: "google/imagen",
          title: "Imagen",
          provider: "google",
          credentialId: "cred-image",
          limits: { maxOutputTokens: 4096 },
        },
        deepResearch: {
          id: "google/gemini-deep-research",
          title: "Deep Research",
          provider: "google",
          credentialId: "cred-research",
        },
      });
    }
  });

  it("rejects a slot without credentialId", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      models: { thinking: { id: "m1", title: "M1" } },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a title slot inside models (strict object)", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      models: {
        ...minimalV3.models,
        title: { id: "gpt-4.1-mini", title: "Mini", credentialId: "cred1" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a coding slot inside models (strict object)", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      models: {
        ...minimalV3.models,
        coding: { id: "gpt-5-codex", title: "Codex", credentialId: "cred1" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("requires workspace as null cwd or repo facts", () => {
    const { workspace: _workspace, ...withoutWorkspace } = minimalV3;
    expect(harnessStreamInputSchema.safeParse(withoutWorkspace).success).toBe(
      false,
    );
    expect(
      harnessStreamInputSchema.safeParse({
        ...minimalV3,
        workspace: { cwd: "" },
      }).success,
    ).toBe(false);
    expect(
      harnessStreamInputSchema.safeParse({
        ...minimalV3,
        workspace: { cwd: "/tmp" },
      }).success,
    ).toBe(false);
    expect(
      harnessStreamInputSchema.safeParse({
        ...minimalV3,
        workspace: { cwd: "/repo", branch: "main" },
      }).success,
    ).toBe(false);
  });

  it("round-trips repo workspace facts", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      workspace: {
        cwd: "/repo",
        repo: {
          owner: "deco",
          name: "site",
          connectedGithub: false,
        },
        branch: "main",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspace).toEqual({
        cwd: "/repo",
        repo: {
          owner: "deco",
          name: "site",
          connectedGithub: false,
        },
        branch: "main",
      });
    }
  });

  it("rejects unknown harness ids", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      harnessId: "made-up",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown harness modes", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      mode: "made-up",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown tool approval levels", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      toolApprovalLevel: "danger",
    });

    expect(result.success).toBe(false);
  });

  it("rejects signal and the removed singular modelSource", () => {
    const withExtras = {
      ...minimalV3,
      signal: { aborted: false },
      modelSource: {
        kind: "secret",
        providerId: "anthropic",
        apiKey: "sk-ant",
        modelId: "claude-sonnet-4",
      },
    };
    const result = harnessStreamInputSchema.safeParse(withExtras);
    expect(result.success).toBe(false);
  });

  it("rejects in-process MCP sources at the wire boundary", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      mcpSource: {
        kind: "in-process",
        client: {},
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an HTTP MCP source outside the v3 contract", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      mcpSource: {
        kind: "http",
        url: "https://studio.example.com/mcp/virtual-mcp/agent-1",
        headers: { Authorization: "Bearer fixture" },
        expiresAt: 9999999999000,
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an HTTP object-storage source outside the v3 contract", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      objectStorageSource: {
        kind: "http",
        baseUrl: "https://studio.example.com/api/acme/object-storage",
        headers: { Authorization: "Bearer fixture" },
        expiresAt: 9999999999000,
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects slot-keyed resolved Decopilot model sources outside the v3 contract", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      modelSources: {
        thinking: {
          kind: "secret",
          providerId: "anthropic",
          apiKey: "sk-main",
          modelId: "claude-sonnet-4",
        },
        fast: {
          kind: "secret",
          providerId: "openai-compatible",
          apiKey: "sk-fast",
          modelId: "gpt-4.1-mini",
          baseUrl: "https://litellm.example.com/v1",
        },
        smart: {
          kind: "secret",
          providerId: "anthropic",
          apiKey: "sk-smart",
          modelId: "claude-opus-4",
        },
        image: {
          kind: "secret",
          providerId: "openrouter",
          apiKey: "sk-image",
          modelId: "google/gemini-2.5-flash-image-preview",
        },
        deepResearch: {
          kind: "secret",
          providerId: "google",
          apiKey: "sk-google",
          modelId: "gemini-2.5-pro-deep-research",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a primary slot inside modelSources (strict object)", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      modelSources: {
        thinking: {
          kind: "secret",
          providerId: "anthropic",
          apiKey: "sk-main",
          modelId: "claude-sonnet-4",
        },
        primary: {
          kind: "secret",
          providerId: "anthropic",
          apiKey: "sk-main",
          modelId: "claude-sonnet-4",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects in-process model sources at the wire boundary", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      modelSources: {
        thinking: {
          kind: "in-process",
          model: {},
          modelId: "claude-sonnet-4",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects legacy nested mcp model secrets", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV3,
      mcp: {
        ...minimalV3.mcp,
        modelSecret: {
          providerId: "anthropic",
          apiKey: "sk-ant",
        },
      },
    });

    expect(result.success).toBe(false);
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
