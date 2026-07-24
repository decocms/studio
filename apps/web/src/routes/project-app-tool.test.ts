import { describe, expect, test } from "bun:test";
import { namespaceCode } from "@decocms/mcp-utils/aggregate";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  findProjectAppTool,
  getUnavailableProjectAppViewKeys,
  hasProjectAppTool,
} from "./project-app-tool";

const UI_META = { ui: { resourceUri: "ui://app/view" } };

function tool(name: string, meta: Record<string, unknown> = UI_META): Tool {
  return {
    name,
    inputSchema: { type: "object" },
    _meta: meta,
  };
}

describe("findProjectAppTool", () => {
  test("finds an exact tool name", () => {
    const match = findProjectAppTool([tool("file_explorer")], "file_explorer");
    expect(match?.name).toBe("file_explorer");
  });

  test("finds a gateway-namespaced tool from its stored base name", () => {
    const clientId = "conn_admin";
    const namespacedName = `${namespaceCode(clientId)}_fetch_assets`;
    const match = findProjectAppTool(
      [tool(namespacedName, { ...UI_META, gatewayClientId: clientId })],
      "fetch_assets",
    );
    expect(match?.name).toBe(namespacedName);
  });

  test("finds a base-name tool from its stored gateway-namespaced name", () => {
    const clientId = "conn_admin";
    const requestedName = `${namespaceCode(clientId)}_fetch_assets`;
    const match = findProjectAppTool(
      [tool("fetch_assets", { ...UI_META, gatewayClientId: clientId })],
      requestedName,
    );
    expect(match?.name).toBe("fetch_assets");
  });
});

describe("hasProjectAppTool", () => {
  test("requires the current tool to expose an app UI", () => {
    expect(hasProjectAppTool([tool("fetch_assets")], "fetch_assets")).toBe(
      true,
    );
    expect(
      hasProjectAppTool(
        [tool("fetch_assets", { gatewayClientId: "conn_admin" })],
        "fetch_assets",
      ),
    ).toBe(false);
  });

  test("returns false for a removed tool", () => {
    expect(hasProjectAppTool([tool("fetch_assets")], "file_explorer")).toBe(
      false,
    );
  });
});

describe("getUnavailableProjectAppViewKeys", () => {
  const candidates = [
    { connectionId: "conn_admin", toolName: "file_explorer" },
    { connectionId: "conn_admin", toolName: "fetch_assets" },
  ];

  test("reproduces a stale pin after the downstream MCP removes a tool", () => {
    const unavailable = getUnavailableProjectAppViewKeys(candidates, [
      {
        connectionId: "conn_admin",
        tools: [tool("fetch_assets")],
      },
    ]);

    expect(unavailable).toEqual(new Set(["conn_admin:file_explorer"]));
  });

  test("preserves persisted views while tools/list is pending or failed", () => {
    const unavailable = getUnavailableProjectAppViewKeys(candidates, [
      { connectionId: "conn_admin" },
    ]);

    expect(unavailable.size).toBe(0);
  });
});
