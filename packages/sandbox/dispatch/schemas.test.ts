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

describe("harnessStreamInputSchema (v2)", () => {
  const minimalV2: HarnessStreamInputWire = {
    threadId: "t1",
    runId: "t1",
    taskId: "t1",
    messages: [],
    workspace: { cwd: "/repo" },
    models: { thinking: { id: "m1", title: "M1", credentialId: "cred1" } },
    mcp: {
      url: "https://x.test/mcp",
      headers: {},
      expiresAt: 1,
    },
    mode: "default",
    temperature: 1,
    toolApprovalLevel: "auto",
    user: { id: "u1", email: "u@x.test" },
    organizationId: "o1",
    virtualMcp: { id: "vm1" },
    agent: { id: "vm1" },
  };

  it("accepts a minimal v2 input", () => {
    const result = harnessStreamInputSchema.safeParse(minimalV2);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.threadId).toBe("t1");
      expect(result.data.workspace).toEqual({ cwd: "/repo" });
      expect(result.data.models.thinking.credentialId).toBe("cred1");
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

    expect(harnessStreamInputSchema.safeParse(v1Input).success).toBe(false);
  });

  it("round-trips all five model slots with per-slot credentialId and harnessId", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
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
      ...minimalV2,
      models: { thinking: { id: "m1", title: "M1" } },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a title slot inside models (strict object)", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      models: {
        ...minimalV2.models,
        title: { id: "gpt-4.1-mini", title: "Mini", credentialId: "cred1" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a coding slot inside models (strict object)", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      models: {
        ...minimalV2.models,
        coding: { id: "gpt-5-codex", title: "Codex", credentialId: "cred1" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("requires workspace with a non-empty cwd", () => {
    const { workspace: _workspace, ...withoutWorkspace } = minimalV2;
    expect(harnessStreamInputSchema.safeParse(withoutWorkspace).success).toBe(
      false,
    );
    expect(
      harnessStreamInputSchema.safeParse({
        ...minimalV2,
        workspace: { cwd: "" },
      }).success,
    ).toBe(false);
  });

  it("round-trips coding workspace facts for desktop harnesses", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      codingWorkspace: {
        repo: {
          owner: "deco",
          name: "site",
          connectedGithub: false,
        },
        branch: "main",
        cwd: "/repo",
        workspaceKind: "github",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.codingWorkspace).toEqual({
        repo: {
          owner: "deco",
          name: "site",
          connectedGithub: false,
        },
        branch: "main",
        cwd: "/repo",
        workspaceKind: "github",
      });
    }
  });

  it("rejects unknown harness ids", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      harnessId: "made-up",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown harness modes", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      mode: "made-up",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown tool approval levels", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      toolApprovalLevel: "danger",
    });

    expect(result.success).toBe(false);
  });

  it("strips signal and the removed singular modelSource", () => {
    const withExtras = {
      ...minimalV2,
      signal: { aborted: false },
      modelSource: {
        kind: "secret",
        providerId: "anthropic",
        apiKey: "sk-ant",
        modelId: "claude-sonnet-4",
      },
    };
    const result = harnessStreamInputSchema.safeParse(withExtras);
    expect(result.success).toBe(true);
    if (result.success) {
      expect("signal" in result.data).toBe(false);
      expect("modelSource" in result.data).toBe(false);
    }
  });

  it("rejects in-process MCP sources at the wire boundary", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      mcpSource: {
        kind: "in-process",
        client: {},
      },
    });

    expect(result.success).toBe(false);
  });

  it("round-trips an HTTP MCP source", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      mcpSource: {
        kind: "http",
        url: "https://mesh.example.com/mcp/virtual-mcp/agent-1",
        headers: { Authorization: "Bearer fixture" },
        expiresAt: 9999999999000,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpSource).toEqual({
        kind: "http",
        url: "https://mesh.example.com/mcp/virtual-mcp/agent-1",
        headers: { Authorization: "Bearer fixture" },
        expiresAt: 9999999999000,
      });
    }
  });

  it("round-trips an HTTP object-storage source", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
      objectStorageSource: {
        kind: "http",
        baseUrl: "https://mesh.example.com/api/acme/object-storage",
        headers: { Authorization: "Bearer fixture" },
        expiresAt: 9999999999000,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.objectStorageSource).toEqual({
        kind: "http",
        baseUrl: "https://mesh.example.com/api/acme/object-storage",
        headers: { Authorization: "Bearer fixture" },
        expiresAt: 9999999999000,
      });
    }
  });

  it("round-trips slot-keyed resolved Decopilot model sources", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
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

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelSources?.thinking.providerId).toBe("anthropic");
      expect(result.data.modelSources?.fast?.baseUrl).toBe(
        "https://litellm.example.com/v1",
      );
      expect(result.data.modelSources?.smart?.providerId).toBe("anthropic");
      expect(result.data.modelSources?.image?.providerId).toBe("openrouter");
      expect(result.data.modelSources?.deepResearch?.providerId).toBe("google");
    }
  });

  it("rejects a primary slot inside modelSources (strict object)", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalV2,
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
      ...minimalV2,
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
      ...minimalV2,
      mcp: {
        ...minimalV2.mcp,
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
