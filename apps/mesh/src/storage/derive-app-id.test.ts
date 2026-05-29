import { describe, expect, it } from "bun:test";
import { deriveAppId, isSyntheticAppId } from "./derive-app-id";

describe("deriveAppId", () => {
  it("returns null for VIRTUAL agents", () => {
    expect(
      deriveAppId({
        connection_type: "VIRTUAL",
        connection_url: "virtual://x",
      }),
    ).toBeNull();
  });

  it("preserves a real registry app_id unchanged", () => {
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "https://api.github.com/mcp",
        app_id: "deco/mcp-github",
      }),
    ).toBe("deco/mcp-github");
  });

  it("derives url: from an HTTP url, dropping query and trailing slash, lowercasing host", () => {
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "https://API.Example.com:443/mcp/?token=abc",
      }),
    ).toBe("url:api.example.com/mcp");
  });

  it("keeps distinct paths distinct", () => {
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "https://x.com/a/mcp",
      }),
    ).toBe("url:x.com/a/mcp");
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "https://x.com/b/mcp",
      }),
    ).toBe("url:x.com/b/mcp");
  });

  it("keeps a non-default port", () => {
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "http://x.com:8080/mcp",
      }),
    ).toBe("url:x.com:8080/mcp");
  });

  it("derives npx: from an npx STDIO connection", () => {
    expect(
      deriveAppId({
        connection_type: "STDIO",
        connection_headers: { command: "npx", args: ["-y", "@deco/foo"] },
      }),
    ).toBe("npx:@deco/foo");
  });

  it("derives stdio: from a generic STDIO command", () => {
    expect(
      deriveAppId({
        connection_type: "STDIO",
        connection_headers: { command: "node", args: ["server.js"] },
      }),
    ).toBe("stdio:node-server-js");
  });

  it("parses connection_headers when given as a JSON string", () => {
    expect(
      deriveAppId({
        connection_type: "STDIO",
        connection_headers: JSON.stringify({ command: "npx", args: ["pkg"] }),
      }),
    ).toBe("npx:pkg");
  });

  it("re-derives when the current app_id is synthetic", () => {
    expect(
      deriveAppId({
        connection_type: "HTTP",
        connection_url: "https://new.com/mcp",
        app_id: "url:old.com/mcp",
      }),
    ).toBe("url:new.com/mcp");
  });

  it("returns null when nothing is derivable and no app_id exists", () => {
    expect(deriveAppId({ connection_type: "STDIO" })).toBeNull();
  });

  it("isSyntheticAppId recognizes synthetic prefixes only", () => {
    expect(isSyntheticAppId("url:x.com")).toBe(true);
    expect(isSyntheticAppId("stdio:node")).toBe(true);
    expect(isSyntheticAppId("npx:pkg")).toBe(true);
    expect(isSyntheticAppId("deco/mcp-github")).toBe(false);
    expect(isSyntheticAppId(null)).toBe(false);
  });
});
