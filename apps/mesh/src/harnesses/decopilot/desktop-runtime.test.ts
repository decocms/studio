import { describe, expect, it } from "bun:test";
import type { HarnessStreamInput } from "@decocms/harness/types";
import { resolveDesktopRuntimeSources } from "./desktop-runtime";

const baseInput = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [],
  workspace: { cwd: "default" },
  models: {
    thinking: { id: "gpt-4.1", title: "GPT", credentialId: "cred-1" },
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

const thinkingSecret = {
  kind: "secret",
  providerId: "openai",
  apiKey: "sk-test",
  modelId: "gpt-4.1",
} as const;

describe("resolveDesktopRuntimeSources", () => {
  it("requires a resolved secret thinking model source", () => {
    expect(() => resolveDesktopRuntimeSources(baseInput)).toThrow(
      /secret thinking model source/,
    );
  });

  it("uses the top-level HTTP MCP source when present", () => {
    const result = resolveDesktopRuntimeSources({
      ...baseInput,
      modelSources: { thinking: thinkingSecret },
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
      modelSources: { thinking: thinkingSecret },
    });

    expect(result.mcpSource).toEqual({
      kind: "http",
      url: baseInput.mcp.url,
      headers: baseInput.mcp.headers,
      expiresAt: baseInput.mcp.expiresAt,
    });
  });
});
