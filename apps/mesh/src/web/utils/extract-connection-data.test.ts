import { describe, expect, it } from "bun:test";
import { getRegistryItemAppName } from "./extract-connection-data";

describe("getRegistryItemAppName", () => {
  it("prefers the mcp.mesh appName over the server name", () => {
    expect(
      getRegistryItemAppName({
        _meta: { "mcp.mesh": { id: "x", appName: "my-app" } },
        server: { name: "server-name" },
      }),
    ).toBe("my-app");
  });

  it("falls back to server.name when appName is absent", () => {
    expect(
      getRegistryItemAppName({
        _meta: { "mcp.mesh": { id: "x" } },
        server: { name: "server-name" },
      }),
    ).toBe("server-name");
  });

  it("falls back to server.name when appName is an empty string", () => {
    expect(
      getRegistryItemAppName({
        _meta: { "mcp.mesh": { id: "x", appName: "" } },
        server: { name: "server-name" },
      }),
    ).toBe("server-name");
  });

  it("returns null when neither appName nor server.name is set", () => {
    expect(getRegistryItemAppName({ server: { name: "" } })).toBeNull();
  });
});
