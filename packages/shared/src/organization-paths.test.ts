import { describe, expect, test } from "bun:test";
import { orgSettingsPath } from "./organization-paths";

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
