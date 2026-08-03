import { describe, expect, it } from "bun:test";
import { fetchToolsFromMCP } from "./fetch-tools";

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
