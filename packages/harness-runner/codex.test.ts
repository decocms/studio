import { describe, expect, test } from "bun:test";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import { codexConfig } from "./codex";

const input: HarnessStreamInputWire = {
  threadId: "thread_example",
  userMessage: { role: "user", parts: [] },
  harness: {},
  workspace: { cwd: "/repo", branch: null },
  models: {
    thinking: {
      id: "gpt-6.1-sol",
      title: "Codex",
      credentialId: "key_example",
    },
  },
  mcp: {
    url: "https://studio.example.com/mcp",
    headers: { Authorization: "Bearer token_example" },
    expiresAt: 1,
  },
  orgMcps: [
    {
      name: "org_tools",
      url: "https://studio.example.com/org-tools",
      headers: {},
    },
  ],
  mode: "default",
  temperature: 0,
  toolApprovalLevel: "auto",
  user: { id: "user_example", email: "user@example.com" },
  organizationId: "org_example",
  agent: { id: "agent_example" },
};

describe("Codex MCP policy", () => {
  test("requires Studio's scoped MCP and preserves distinct organization servers", () => {
    expect(codexConfig(input)).toEqual({
      mcp_servers: {
        studio: {
          url: input.mcp.url,
          http_headers: input.mcp.headers,
          required: true,
        },
        org_tools: {
          url: input.orgMcps![0].url,
          http_headers: {},
          required: false,
        },
      },
    });
  });

  test("plan and readonly runs cannot call mutating MCP tools", () => {
    for (const restricted of [
      { ...input, mode: "plan" as const },
      { ...input, toolApprovalLevel: "readonly" as const },
    ]) {
      const config = codexConfig({
        ...restricted,
        toolAllowlist: ["web_search", "TASK_BOARD_ITEM_UPDATE"],
      });
      expect(config).toMatchObject({
        mcp_servers: {
          studio: { enabled: true, enabled_tools: ["web_search"] },
          org_tools: { enabled: false },
        },
      });
    }
  });
});
