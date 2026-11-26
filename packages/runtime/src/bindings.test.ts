import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { proxyConnectionForId, Secret } from "./bindings.ts";

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

describe("Secret", () => {
  test("marks the field so Studio treats it as secret", () => {
    const schema = z.toJSONSchema(
      z.object({
        accountName: z.string(),
        appKey: Secret(),
        appToken: Secret().optional().describe("token"),
        nullableToken: Secret().nullable(),
      }),
    );
    // Studio reads `format: "password"` (secretFieldsFromStateSchema).
    expect(schema.properties).toMatchObject({
      accountName: { type: "string" },
      appKey: { type: "string", format: "password" },
      appToken: { type: "string", format: "password", description: "token" },
      nullableToken: {
        anyOf: [{ type: "string", format: "password" }, { type: "null" }],
      },
    });
    expect(schema.properties?.accountName).not.toHaveProperty("format");
  });

  test("still validates as a string", () => {
    expect(Secret().parse("abc")).toBe("abc");
    expect(() => Secret().parse(1)).toThrow();
  });
});
