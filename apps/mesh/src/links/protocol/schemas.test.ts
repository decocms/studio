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

  it("round-trips full model slot metadata", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
      models: {
        credentialId: "cred-chat",
        thinking: {
          id: "anthropic/claude-sonnet",
          title: "Sonnet",
          provider: null,
          limits: { contextWindow: 200000, maxOutputTokens: 32768 },
        },
        image: {
          credentialId: "cred-image",
          id: "google/imagen",
          title: "Imagen",
          provider: "google",
          limits: { maxOutputTokens: 4096 },
        },
        deepResearch: {
          credentialId: "cred-research",
          id: "google/gemini-deep-research",
          title: "Deep Research",
          provider: "google",
        },
        title: {
          id: "openai/gpt-4.1-mini",
          title: "GPT 4.1 Mini",
          provider: "openai",
          limits: { maxOutputTokens: 2048 },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models).toEqual({
        credentialId: "cred-chat",
        thinking: {
          id: "anthropic/claude-sonnet",
          title: "Sonnet",
          provider: null,
          limits: { contextWindow: 200000, maxOutputTokens: 32768 },
        },
        image: {
          credentialId: "cred-image",
          id: "google/imagen",
          title: "Imagen",
          provider: "google",
          limits: { maxOutputTokens: 4096 },
        },
        deepResearch: {
          credentialId: "cred-research",
          id: "google/gemini-deep-research",
          title: "Deep Research",
          provider: "google",
        },
        title: {
          id: "openai/gpt-4.1-mini",
          title: "GPT 4.1 Mini",
          provider: "openai",
          limits: { maxOutputTokens: 2048 },
        },
      });
    }
  });

  it("rejects unknown harness modes", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
      mode: "made-up",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown tool approval levels", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
      toolApprovalLevel: "danger",
    });

    expect(result.success).toBe(false);
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

  it("rejects in-process MCP sources at the wire boundary", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
      mcpSource: {
        kind: "in-process",
        client: {},
      },
    });

    expect(result.success).toBe(false);
  });

  it("round-trips an HTTP MCP source", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
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
      ...minimalInput,
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

  it("round-trips a resolved secret model source", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
      modelSource: {
        kind: "secret",
        providerId: "openai-compatible",
        apiKey: "sk-test",
        modelId: "gpt-4.1",
        baseUrl: "https://litellm.example.com/v1",
        extraHeaders: { "x-provider": "mesh" },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelSource).toEqual({
        kind: "secret",
        providerId: "openai-compatible",
        apiKey: "sk-test",
        modelId: "gpt-4.1",
        baseUrl: "https://litellm.example.com/v1",
        extraHeaders: { "x-provider": "mesh" },
      });
    }
  });

  it("round-trips resolved Decopilot model sources for tool and title slots", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
      modelSources: {
        primary: {
          kind: "secret",
          providerId: "anthropic",
          apiKey: "sk-main",
          modelId: "claude-sonnet-4",
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
        title: {
          kind: "secret",
          providerId: "openai-compatible",
          apiKey: "sk-title",
          modelId: "gpt-4.1-mini",
          baseUrl: "https://litellm.example.com/v1",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelSources?.primary.providerId).toBe("anthropic");
      expect(result.data.modelSources?.image?.providerId).toBe("openrouter");
      expect(result.data.modelSources?.deepResearch?.providerId).toBe("google");
      expect(result.data.modelSources?.title?.baseUrl).toBe(
        "https://litellm.example.com/v1",
      );
    }
  });

  it("rejects legacy nested mcp model secrets", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
      mcp: {
        ...minimalInput.mcp,
        modelSecret: {
          providerId: "anthropic",
          apiKey: "sk-ant",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects in-process model sources at the wire boundary", () => {
    const result = harnessStreamInputSchema.safeParse({
      ...minimalInput,
      modelSource: {
        kind: "in-process",
        model: {},
        modelId: "claude-sonnet-4",
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
