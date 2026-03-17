import type { ConnectionEntity } from "@/tools/connection/schema";
import {
  connectionImplementsBinding,
  resolveBindingType,
} from "@/web/hooks/use-binding";
import { MCP_BINDING } from "@decocms/bindings/mcp";
import { EVENT_BUS_BINDING } from "@decocms/bindings";
import { LANGUAGE_MODEL_BINDING } from "@decocms/bindings/llm";
import { describe, expect, it } from "bun:test";

function makeConnection(
  tools: Array<{ name: string; inputSchema: Record<string, unknown> }>,
  overrides?: Partial<ConnectionEntity>,
): ConnectionEntity {
  return {
    id: "test-conn",
    title: "Test Connection",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "user-1",
    organization_id: "org-1",
    connection_type: "HTTP",
    connection_url: "https://example.com",
    connection_token: null,
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: null,
    bindings: [],
    status: "active",
    tools,
    ...overrides,
  };
}

describe("connectionImplementsBinding", () => {
  it("should detect MCP binding when tools match", () => {
    const conn = makeConnection([
      { name: "MCP_CONFIGURATION", inputSchema: {} },
    ]);
    expect(connectionImplementsBinding(conn, MCP_BINDING)).toBe(true);
  });

  it("should not detect MCP binding when tools do not match", () => {
    const conn = makeConnection([{ name: "SOME_OTHER_TOOL", inputSchema: {} }]);
    expect(connectionImplementsBinding(conn, MCP_BINDING)).toBe(false);
  });

  it("should detect EVENT_BUS binding when connection has all event bus tools", () => {
    const conn = makeConnection([
      { name: "EVENT_PUBLISH", inputSchema: {} },
      { name: "EVENT_SUBSCRIBE", inputSchema: {} },
      { name: "EVENT_UNSUBSCRIBE", inputSchema: {} },
      { name: "EVENT_CANCEL", inputSchema: {} },
      { name: "EVENT_ACK", inputSchema: {} },
      { name: "EVENT_SYNC_SUBSCRIPTIONS", inputSchema: {} },
    ]);
    expect(connectionImplementsBinding(conn, EVENT_BUS_BINDING)).toBe(true);
  });

  it("should not detect EVENT_BUS binding when missing required tools", () => {
    const conn = makeConnection([
      { name: "EVENT_PUBLISH", inputSchema: {} },
      { name: "EVENT_SUBSCRIBE", inputSchema: {} },
    ]);
    expect(connectionImplementsBinding(conn, EVENT_BUS_BINDING)).toBe(false);
  });

  it("should detect LANGUAGE_MODEL binding when connection has LLM tools", () => {
    const conn = makeConnection([
      { name: "LLM_METADATA", inputSchema: {} },
      { name: "LLM_DO_STREAM", inputSchema: {} },
      { name: "LLM_DO_GENERATE", inputSchema: {} },
      { name: "LLM_LIST", inputSchema: {} },
      { name: "LLM_GET", inputSchema: {} },
    ]);
    expect(connectionImplementsBinding(conn, LANGUAGE_MODEL_BINDING)).toBe(
      true,
    );
  });

  it("should not detect LANGUAGE_MODEL binding when missing LLM tools", () => {
    const conn = makeConnection([
      { name: "LLM_METADATA", inputSchema: {} },
      { name: "SOME_OTHER_TOOL", inputSchema: {} },
    ]);
    expect(connectionImplementsBinding(conn, LANGUAGE_MODEL_BINDING)).toBe(
      false,
    );
  });

  it("should return false for connection with no tools", () => {
    const conn = makeConnection([]);
    expect(connectionImplementsBinding(conn, EVENT_BUS_BINDING)).toBe(false);
    expect(connectionImplementsBinding(conn, LANGUAGE_MODEL_BINDING)).toBe(
      false,
    );
  });
});

describe("resolveBindingType", () => {
  it("should resolve @deco/event-bus to EVENT_BUS", () => {
    expect(resolveBindingType("@deco/event-bus")).toBe("EVENT_BUS");
  });

  it("should resolve @deco/llm to LLMS", () => {
    expect(resolveBindingType("@deco/llm")).toBe("LLMS");
  });

  it("should return undefined for unknown binding types", () => {
    expect(resolveBindingType("@deco/unknown")).toBeUndefined();
    expect(resolveBindingType("@other/something")).toBeUndefined();
  });

  it("should return undefined for undefined input", () => {
    expect(resolveBindingType(undefined)).toBeUndefined();
  });

  it("should not resolve @deco/language-model (handled by dedicated ModelSelector)", () => {
    expect(resolveBindingType("@deco/language-model")).toBeUndefined();
  });

  it("should not resolve @deco/agent (handled by dedicated VirtualMCPSelector)", () => {
    expect(resolveBindingType("@deco/agent")).toBeUndefined();
  });
});
