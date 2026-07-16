import { describe, expect, test } from "bun:test";
import { apiKeyManagerAgent } from "./api-key-manager";

describe("apiKeyManagerAgent", () => {
  test("uses an org-scoped id", () => {
    expect(apiKeyManagerAgent.getId("org_xyz")).toBe(
      "studio-api-key-manager_org_xyz",
    );
  });

  test("exposes API key mutations, vault secrets, and read-only target discovery", () => {
    expect(apiKeyManagerAgent.selectedTools).toEqual([
      "API_KEY_CREATE",
      "API_KEY_LIST",
      "API_KEY_UPDATE",
      "API_KEY_DELETE",
      "SECRET_CREATE",
      "SECRET_LIST",
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
  });

  test("relies exclusively on the shown-once UI panel — never prints the key itself", () => {
    expect(apiKeyManagerAgent.instructions).toContain(
      'secure "shown once" panel',
    );
    expect(apiKeyManagerAgent.instructions).toContain(
      "NEVER print the key value yourself, under any circumstance",
    );
    expect(apiKeyManagerAgent.instructions).toContain(
      "Never reprint the value",
    );
  });

  test("refuses to create a key when running as a delegated subtask, since the panel can't render there", () => {
    expect(apiKeyManagerAgent.instructions).toContain(
      "not inside a delegated subtask",
    );
    expect(apiKeyManagerAgent.instructions).toContain("do NOT create the key");
    expect(apiKeyManagerAgent.instructions).toContain(
      "key creation needs a direct conversation",
    );
  });

  test("forbids delegating the actual creation to a further subagent", () => {
    expect(apiKeyManagerAgent.instructions).toContain(
      "never delegate the actual creation to a further subagent",
    );
  });

  test("skips the pre-creation interview and honors explicit wildcard/full-access requests", () => {
    expect(apiKeyManagerAgent.instructions).toContain(
      "do not run a multi-question interview first",
    );
    expect(apiKeyManagerAgent.instructions).toContain(
      "do not push back or repeatedly re-confirm",
    );
  });
});
