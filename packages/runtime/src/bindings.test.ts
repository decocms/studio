import { describe, expect, test } from "bun:test";
import { proxyConnectionForId } from "./bindings.ts";

describe("proxyConnectionForId", () => {
  test("prefers studioUrl over the deprecated meshUrl alias", () => {
    const connection = proxyConnectionForId("connection-1", {
      studioUrl: "https://studio.example.com",
      meshUrl: "https://legacy.example.com",
    });

    expect("url" in connection).toBe(true);
    if ("url" in connection) {
      expect(connection.url).toBe(
        "https://studio.example.com/mcp/connection-1",
      );
    }
  });

  test("accepts meshUrl for backwards compatibility", () => {
    const connection = proxyConnectionForId("connection-1", {
      meshUrl: "https://legacy.example.com",
    });

    expect("url" in connection).toBe(true);
    if ("url" in connection) {
      expect(connection.url).toBe(
        "https://legacy.example.com/mcp/connection-1",
      );
    }
  });
});
