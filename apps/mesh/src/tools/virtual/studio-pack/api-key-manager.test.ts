import { describe, expect, test } from "bun:test";
import { apiKeyManagerAgent } from "./api-key-manager";

describe("apiKeyManagerAgent", () => {
  test("uses an org-scoped id", () => {
    expect(apiKeyManagerAgent.getId("org_xyz")).toBe(
      "studio-api-key-manager_org_xyz",
    );
  });

  test("exposes API key mutations and read-only target discovery", () => {
    expect(apiKeyManagerAgent.selectedTools).toEqual([
      "API_KEY_CREATE",
      "API_KEY_LIST",
      "API_KEY_UPDATE",
      "API_KEY_DELETE",
      "COLLECTION_VIRTUAL_MCP_LIST",
      "COLLECTION_VIRTUAL_MCP_GET",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
    ]);
  });

  test("requires confirmation and one-time secret handling", () => {
    expect(apiKeyManagerAgent.instructions).toContain(
      "get explicit confirmation",
    );
    expect(apiKeyManagerAgent.instructions).toContain(
      "returns the key value exactly once",
    );
    expect(apiKeyManagerAgent.instructions).toContain(
      "print that value exactly once in a fenced plain-text code block",
    );
    expect(apiKeyManagerAgent.instructions).not.toContain(
      "Never reproduce the key value",
    );
  });
});
