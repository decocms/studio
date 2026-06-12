import { describe, expect, it } from "bun:test";
import { buildOrgFsConfig, homeMountPath } from "./provisioning";

describe("buildOrgFsConfig", () => {
  it("returns home (slug-mounted) + outputs + uploads with the given identity", () => {
    const c = buildOrgFsConfig({
      baseUrl: "https://cluster.example",
      orgSlug: "acme",
      token: "tok_abc",
    });
    expect(c.orgSlug).toBe("acme");
    expect(c.token).toBe("tok_abc");
    expect(c.mounts).toEqual([
      { volume: "home", path: "acme" },
      { volume: "outputs", path: ".outputs" },
      { volume: "uploads", path: ".uploads" },
    ]);
  });

  it("strips trailing slashes from baseUrl", () => {
    expect(
      buildOrgFsConfig({ baseUrl: "http://x/", orgSlug: "o", token: "t" })
        .baseUrl,
    ).toBe("http://x");
  });
});

describe("homeMountPath", () => {
  it("uses the org slug as the mount path", () => {
    expect(homeMountPath("acme")).toBe("acme");
    expect(homeMountPath("my-org.2")).toBe("my-org.2");
  });

  it("falls back to 'home' for reserved or unsafe slugs", () => {
    for (const bad of ["output", "upload", "public", "home"]) {
      expect(homeMountPath(bad)).toBe("home");
    }
    for (const bad of [".hidden", "a/b", "", "..", "with space"]) {
      expect(homeMountPath(bad)).toBe("home");
    }
  });
});
