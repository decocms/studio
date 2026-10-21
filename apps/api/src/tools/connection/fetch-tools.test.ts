import { describe, expect, it } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  buildConnectionRequestHeaders,
  fetchScopesFromMCP,
  fetchToolsFromMCP,
} from "./fetch-tools";

function fakeClient(responseText: string): Client {
  return {
    callTool: async () => ({
      isError: false,
      content: [{ type: "text", text: responseText }],
    }),
  } as unknown as Client;
}

describe("buildConnectionRequestHeaders", () => {
  it("merges bearer token and custom headers for an HTTP connection", () => {
    const headers = buildConnectionRequestHeaders({
      id: "conn-1",
      title: "http",
      connection_type: "HTTP",
      connection_token: "secret",
      connection_headers: { headers: { "X-Custom": "value" } },
    });

    expect(headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
      "X-Custom": "value",
    });
  });

  it("drops an unsafe custom header instead of forwarding a value fetch would throw on", () => {
    const headers = buildConnectionRequestHeaders({
      id: "conn-3",
      title: "http",
      connection_type: "HTTP",
      connection_headers: {
        headers: { "X-Custom": "value", "X-Evil": "line1\r\nline2" },
      },
    });

    expect(headers).toEqual({
      "Content-Type": "application/json",
      "X-Custom": "value",
    });
  });

  it("ignores STDIO-shaped connection_headers instead of misreading them", () => {
    const headers = buildConnectionRequestHeaders({
      id: "conn-2",
      title: "stdio-shaped",
      connection_type: "HTTP",
      connection_headers: { command: "npx", args: ["some-mcp"] },
    });

    expect(headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("fetchScopesFromMCP", () => {
  it("returns scopes when every element is a string", async () => {
    const scopes = await fetchScopesFromMCP(
      fakeClient(JSON.stringify({ scopes: ["CONFIG::READ"] })),
    );
    expect(scopes).toEqual(["CONFIG::READ"]);
  });

  it("rejects a response whose scopes array holds a non-string element", async () => {
    const scopes = await fetchScopesFromMCP(
      fakeClient(JSON.stringify({ scopes: ["CONFIG::READ", 42] })),
    );
    expect(scopes).toBeNull();
  });
});

describe("fetchToolsFromMCP SSRF guard", () => {
  it("blocks an HTTP connection URL targeting a private/loopback address", async () => {
    const result = await fetchToolsFromMCP({
      id: "conn-1",
      title: "evil",
      connection_type: "HTTP",
      connection_url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(result).toBeNull();
  });

  it("blocks an SSE connection URL targeting a private/loopback address", async () => {
    const result = await fetchToolsFromMCP({
      id: "conn-2",
      title: "evil",
      connection_type: "SSE",
      connection_url: "http://127.0.0.1:9999/mcp",
    });
    expect(result).toBeNull();
  });
});
