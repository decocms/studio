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

  test("confirms before deletion and keeps one-time secret handling", () => {
    // De-nagged agent: no interview / no wildcard pushback, but destructive
    // and secret-hygiene guardrails are retained.
    expect(apiKeyManagerAgent.instructions).toContain(
      "single explicit confirmation immediately before API_KEY_DELETE",
    );
    expect(apiKeyManagerAgent.instructions).toContain(
      "returns the key value exactly once",
    );
    expect(apiKeyManagerAgent.instructions).toContain(
      "Print that value once in a fenced plain-text code block",
    );
    expect(apiKeyManagerAgent.instructions).toContain(
      "don't repeat it in later prose",
    );
  });
});
