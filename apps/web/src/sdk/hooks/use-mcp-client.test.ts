import { describe, expect, test } from "bun:test";
import { mcpClientQueryOptions } from "./use-mcp-client";

const baseOptions = {
  connectionId: "connection-1",
  orgId: "organization-1",
  orgSlug: "example-org",
};

describe("mcpClientQueryOptions", () => {
  test("scopes the client by studioUrl", () => {
    const options = mcpClientQueryOptions({
      ...baseOptions,
      studioUrl: "https://studio.example.com",
    });

    expect(options.queryKey).toEqual([
      "mcp",
      "client",
      "organization-1",
      "connection-1",
      "",
      "https://studio.example.com",
    ]);
  });

  test("keeps meshUrl as an alias and prefers studioUrl", () => {
    const aliasOptions = mcpClientQueryOptions({
      ...baseOptions,
      meshUrl: "https://legacy.example.com",
    });
    const preferredOptions = mcpClientQueryOptions({
      ...baseOptions,
      studioUrl: "https://studio.example.com",
      meshUrl: "https://legacy.example.com",
    });

    expect(aliasOptions.queryKey.at(-1)).toBe("https://legacy.example.com");
    expect(preferredOptions.queryKey.at(-1)).toBe("https://studio.example.com");
  });
});
