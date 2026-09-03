import { describe, expect, test } from "bun:test";
import { agentAppPath, orgSettingsPath } from "./organization-paths";

describe("orgSettingsPath", () => {
  test("puts member-facing pages under /settings, not the org root", () => {
    // `/acme/members` matches no route: it falls through to `/$org/$taskId`.
    expect(orgSettingsPath("acme", "members")).toBe("/acme/settings/members");
    expect(orgSettingsPath("acme", "infra-billing")).toBe(
      "/acme/settings/infra-billing",
    );
  });

  test("omitting the page yields the settings index", () => {
    expect(orgSettingsPath("acme")).toBe("/acme/settings");
  });

  test("encodes slugs so a hostile one cannot escape the segment", () => {
    expect(orgSettingsPath("a/b", "members")).toBe("/a%2Fb/settings/members");
    expect(orgSettingsPath("a b")).toBe("/a%20b/settings");
  });
});

describe("agentAppPath", () => {
  test("puts agent and app identity in canonical path segments", () => {
    expect(
      agentAppPath("acme", {
        agentId: "commerce_agent",
        connectionId: "commerce_connection",
        toolName: "get_my_diagnostic",
      }),
    ).toBe(
      "/acme/agents/commerce_agent/apps/commerce_connection/get_my_diagnostic",
    );
  });

  test("encodes identities and keeps optional app state in search", () => {
    const path = agentAppPath("a/b", {
      agentId: "agent/one",
      connectionId: "connection/one",
      toolName: "tool name",
      search: { thread: "thread/one" },
    });

    expect(path).toBe(
      "/a%2Fb/agents/agent%2Fone/apps/connection%2Fone/tool%20name?thread=thread%2Fone",
    );
    expect(path).not.toContain("virtualmcpid");
    expect(path).not.toContain("connection=");
    expect(path).not.toContain("tool=");
  });
});
