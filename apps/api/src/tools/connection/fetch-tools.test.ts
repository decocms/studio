import { describe, expect, it } from "bun:test";
import {
  buildConnectionRequestHeaders,
  fetchToolsFromMCP,
} from "./fetch-tools";

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
