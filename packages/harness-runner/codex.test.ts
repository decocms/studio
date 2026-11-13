import { describe, expect, test } from "bun:test";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexConfig,
  codexPluginDirs,
  codexStudioCliOrg,
  codexTurnFailure,
} from "./codex";

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

  test("a studioCli run mounts no Studio server", () => {
    const cli = { ...input, studioCli: { org: "example-org" } };
    expect(codexStudioCliOrg(cli)).toBe("example-org");
    expect(codexConfig(cli)).toEqual({
      mcp_servers: {
        org_tools: {
          url: input.orgMcps![0].url,
          http_headers: {},
          required: false,
        },
      },
    });
    expect(codexStudioCliOrg(input)).toBe(null);
  });

  test("a read-only studioCli run keeps Studio's research MCP: its shell has no network", () => {
    for (const restricted of [
      { ...input, mode: "plan" as const },
      { ...input, toolApprovalLevel: "readonly" as const },
    ]) {
      const cli = { ...restricted, studioCli: { org: "example-org" } };
      expect(codexStudioCliOrg(cli)).toBe(null);
      expect(codexConfig(cli)).toEqual(codexConfig(restricted));
    }
  });

  test("a studioCli run with a tool allowlist keeps the Studio MCP, which enforces it", () => {
    const allowlisted = { ...input, toolAllowlist: ["TASK_BOARD_ITEM_LIST"] };
    const cli = { ...allowlisted, studioCli: { org: "example-org" } };
    expect(codexStudioCliOrg(cli)).toBe(null);
    expect(codexConfig(cli)).toEqual(codexConfig(allowlisted));
  });

  test("a studioCli run also discovers the image's decocms-studio skills", () => {
    const prev = {
      plugin: process.env.DECOCMS_STUDIO_PLUGIN_DIR,
      plugins: process.env.CLAUDE_CODE_PLUGIN_DIRS,
    };
    try {
      const dir = mkdtempSync(join(tmpdir(), "studio-plugin-"));
      process.env.DECOCMS_STUDIO_PLUGIN_DIR = dir;
      process.env.CLAUDE_CODE_PLUGIN_DIRS = "/skills/org";
      const cli = { ...input, studioCli: { org: "example-org" } };
      expect(codexPluginDirs(cli)).toEqual(["/skills/org", dir]);
      expect(codexPluginDirs(input)).toEqual(["/skills/org"]);
      expect(codexPluginDirs({ ...cli, mode: "plan" })).toEqual([
        "/skills/org",
      ]);
      process.env.DECOCMS_STUDIO_PLUGIN_DIR = join(dir, "missing");
      expect(codexPluginDirs(cli)).toEqual(["/skills/org"]);
    } finally {
      for (const [name, value] of [
        ["DECOCMS_STUDIO_PLUGIN_DIR", prev.plugin],
        ["CLAUDE_CODE_PLUGIN_DIRS", prev.plugins],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("Codex turn failures", () => {
  // Shapes recorded from `codex app-server` 0.163.0 against a refusing endpoint.
  test("unwraps a JSON response body to the provider's message", () => {
    expect(
      codexTurnFailure({
        message:
          '{"error":{"message":"The model `gpt-example` is not supported when using Codex with a ChatGPT account.","type":"invalid_request_error"}}',
        codexErrorInfo: "other",
      }),
    ).toBe(
      "Codex turn failed: The model `gpt-example` is not supported when using Codex with a ChatGPT account.",
    );
  });

  test("drops the request URL and redacts credentials", () => {
    const message = codexTurnFailure({
      message:
        "unexpected status 401 Unauthorized: invalid key sk-example123 or Bearer token_example, url: https://provider.example.com/v1/responses?key=secret",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
    });
    expect(message).toBe(
      "Codex turn failed: unexpected status 401 Unauthorized: invalid key [redacted] or [redacted]",
    );
  });

  test("caps an oversized reason", () => {
    const message = codexTurnFailure({ message: "x".repeat(2000) });
    expect(message.length).toBeLessThan(600);
    expect(message.endsWith("…")).toBe(true);
  });

  test("falls back to the generic hint without a reason", () => {
    for (const error of [undefined, null, {}, { message: "  " }])
      expect(codexTurnFailure(error)).toContain(
        "Check your provider connection or relink the ChatGPT subscription.",
      );
  });
});
