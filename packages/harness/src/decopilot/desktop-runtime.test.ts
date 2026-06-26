import { describe, expect, it } from "bun:test";
import type { HarnessStreamInput } from "../types";
import {
  resolveDesktopRuntimeSources,
  resolveDesktopSubtaskCodingWorkspace,
} from "./desktop-runtime";
import { setDecopilotRunContext } from "./run-context";

const baseInput = {
  threadId: "thread-1",
  userMessage: {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
  },
  harness: {},
  workspace: { cwd: null },
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
    setDecopilotRunContext(baseInput, {
      virtualMcp: { id: "agent-1", metadata: {} },
    });
    expect(() => resolveDesktopRuntimeSources(baseInput)).toThrow(
      /secret thinking model source/,
    );
  });

  it("uses the top-level HTTP MCP source when present", () => {
    const input = { ...baseInput };
    setDecopilotRunContext(input, {
      virtualMcp: { id: "agent-1", metadata: {} },
      modelSources: { thinking: thinkingSecret },
      mcpSource: {
        kind: "http",
        url: "https://studio.example.com/mcp/source",
        headers: { Authorization: "Bearer source" },
        expiresAt: 9999999999001,
      },
    });
    const result = resolveDesktopRuntimeSources(input);

    expect(result.mcpSource.url).toBe("https://studio.example.com/mcp/source");
    expect(result.mcpSource.headers.Authorization).toBe("Bearer source");
  });

  it("falls back to the legacy HTTP mcp envelope when mcpSource is absent", () => {
    const input = { ...baseInput };
    setDecopilotRunContext(input, {
      virtualMcp: { id: "agent-1", metadata: {} },
      modelSources: { thinking: thinkingSecret },
    });
    const result = resolveDesktopRuntimeSources(input);

    expect(result.mcpSource).toEqual({
      kind: "http",
      url: baseInput.mcp.url,
      headers: baseInput.mcp.headers,
      expiresAt: baseInput.mcp.expiresAt,
    });
  });
});

describe("resolveDesktopSubtaskCodingWorkspace", () => {
  const codingWorkspace = {
    repo: {
      owner: "deco",
      name: "site",
      connectedGithub: true,
    },
    branch: "main",
    cwd: "/repo",
    workspaceKind: "github",
  } as const;

  it("preserves the parent coding workspace for self-clone subtasks", () => {
    expect(
      resolveDesktopSubtaskCodingWorkspace(
        {
          workspace: {
            cwd: "/repo",
            repo: codingWorkspace.repo,
            branch: codingWorkspace.branch,
          },
        },
        undefined,
      ),
    ).toEqual(codingWorkspace);
  });

  it("clears the parent coding workspace for cross-agent subtasks", () => {
    expect(
      resolveDesktopSubtaskCodingWorkspace(
        {
          workspace: {
            cwd: "/repo",
            repo: codingWorkspace.repo,
            branch: codingWorkspace.branch,
          },
        },
        "agent-2",
      ),
    ).toBeUndefined();
  });
});
