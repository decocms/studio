import { describe, expect, it } from "bun:test";
import { buildOrgFsConfig } from "./provisioning";

describe("buildOrgFsConfig", () => {
  it("returns the hardcoded skills + outputs mounts with the given identity", () => {
    const c = buildOrgFsConfig({
      baseUrl: "https://cluster.example",
      orgSlug: "acme",
      token: "tok_abc",
    });
    expect(c.orgSlug).toBe("acme");
    expect(c.token).toBe("tok_abc");
    expect(c.mounts).toEqual([
      { volume: "skills", path: "skills" },
      { volume: "outputs", path: ".outputs" },
    ]);
  });

  it("strips trailing slashes from baseUrl", () => {
    expect(
      buildOrgFsConfig({ baseUrl: "http://x/", orgSlug: "o", token: "t" })
        .baseUrl,
    ).toBe("http://x");
  });
});
