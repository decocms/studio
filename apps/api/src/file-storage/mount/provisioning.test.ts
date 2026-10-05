import { describe, expect, it } from "bun:test";
import { homeDisplayName } from "@decocms/shared/organization/home-mount";
import { buildOrgFsConfig, orgFsSandboxPath } from "./provisioning";

describe("buildOrgFsConfig", () => {
  it("returns home (fixed home mount) + outputs + uploads with the given identity", () => {
    const c = buildOrgFsConfig({
      baseUrl: "https://cluster.example",
      orgSlug: "acme",
      token: "tok_abc",
    });
    expect(c.orgSlug).toBe("acme");
    expect(c.token).toBe("tok_abc");
    expect(c.mounts).toEqual([
      { volume: "home", path: "home" },
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

describe("orgFsSandboxPath", () => {
  it("maps each volume to its absolute mount under /app/org", () => {
    expect(orgFsSandboxPath("home", "decks/a.html")).toBe(
      "/app/org/home/decks/a.html",
    );
    expect(orgFsSandboxPath("outputs", "t1/x.png")).toBe(
      "/app/org/.outputs/t1/x.png",
    );
    expect(orgFsSandboxPath("uploads", "t1/a.pdf")).toBe(
      "/app/org/.uploads/t1/a.pdf",
    );
    expect(orgFsSandboxPath("public-core", "slides")).toBe(
      "/app/org/public/core/slides",
    );
    expect(orgFsSandboxPath("my-repo", "skills/x")).toBe(
      "/app/org/my-repo/skills/x",
    );
  });

  it("returns the mount root for an empty path", () => {
    expect(orgFsSandboxPath("home", "")).toBe("/app/org/home");
  });
});

describe("homeDisplayName", () => {
  it("uses the org slug as the Library label", () => {
    expect(homeDisplayName("acme")).toBe("acme");
    expect(homeDisplayName("my-org.2")).toBe("my-org.2");
  });

  it("falls back to 'home' for reserved or unsafe slugs", () => {
    for (const bad of ["output", "upload", "public", "home"]) {
      expect(homeDisplayName(bad)).toBe("home");
    }
    for (const bad of [".hidden", "a/b", "", "..", "with space"]) {
      expect(homeDisplayName(bad)).toBe("home");
    }
  });
});
