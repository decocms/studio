import { describe, expect, it } from "bun:test";
import type { HarnessStreamInput } from "../types";
import { resolveDesktopRuntimeSources } from "./index";

const baseInput = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [],
  models: {
    credentialId: "cred-1",
    thinking: { id: "gpt-4.1", title: "GPT" },
  },
  mcp: {
    url: "https://studio.example.com/mcp/agent-1",
    headers: { Authorization: "Bearer test" },
    expiresAt: 9999999999000,
  },
  mode: "default",
  temperature: 0.5,
  toolApprovalLevel: "auto",
  user: { id: "user-1", email: "user@example.com" },
  organizationId: "org-1",
  virtualMcp: { id: "agent-1", metadata: {} },
  agent: { id: "agent-1" },
  signal: new AbortController().signal,
} satisfies HarnessStreamInput;

describe("resolveDesktopRuntimeSources", () => {
  it("requires a resolved secret model source", () => {
    expect(() => resolveDesktopRuntimeSources(baseInput)).toThrow(
      /requires a secret modelSource/,
    );
  });

  it("uses the top-level HTTP MCP source when present", () => {
    const result = resolveDesktopRuntimeSources({
      ...baseInput,
      modelSource: {
        kind: "secret",
        providerId: "openai",
        apiKey: "sk-test",
        modelId: "gpt-4.1",
      },
      mcpSource: {
        kind: "http",
        url: "https://studio.example.com/mcp/source",
        headers: { Authorization: "Bearer source" },
        expiresAt: 9999999999001,
      },
    });

    expect(result.mcpSource.url).toBe("https://studio.example.com/mcp/source");
    expect(result.mcpSource.headers.Authorization).toBe("Bearer source");
  });

  it("falls back to the legacy HTTP mcp envelope when mcpSource is absent", () => {
    const result = resolveDesktopRuntimeSources({
      ...baseInput,
      modelSource: {
        kind: "secret",
        providerId: "openai",
        apiKey: "sk-test",
        modelId: "gpt-4.1",
      },
    });

    expect(result.mcpSource).toEqual({
      kind: "http",
      url: baseInput.mcp.url,
      headers: baseInput.mcp.headers,
      expiresAt: baseInput.mcp.expiresAt,
    });
  });
});
