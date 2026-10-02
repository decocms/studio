import { describe, expect, it } from "bun:test";
import { orgRelativePath } from "./home-mount";

describe("orgRelativePath", () => {
  it("strips the absolute org root", () => {
    expect(orgRelativePath("/app/org/output/qa/x.png")).toBe("output/qa/x.png");
  });

  it("strips the legacy cwd-relative prefix", () => {
    expect(orgRelativePath("org/output/x.png")).toBe("output/x.png");
    expect(orgRelativePath("./org/home/decks/a.html")).toBe(
      "home/decks/a.html",
    );
  });

  it("rejects paths outside org-fs", () => {
    expect(orgRelativePath("/app/repo/src/x.ts")).toBeNull();
    expect(orgRelativePath("/app/organization/x")).toBeNull();
    expect(orgRelativePath("xorg/output/x.png")).toBeNull();
    expect(orgRelativePath("https://example.com/org/output/x.png")).toBeNull();
    expect(orgRelativePath("")).toBeNull();
  });

  it("rejects parent segments", () => {
    expect(orgRelativePath("/app/org/output/../other/x.png")).toBeNull();
    expect(orgRelativePath("org/output/../../etc/passwd")).toBeNull();
    expect(orgRelativePath("/app/org/output/a..b.png")).toBe("output/a..b.png");
  });
});
