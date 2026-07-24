import { describe, expect, it } from "bun:test";
import { resolveOrgFileBrowsePath } from "./org-file-ref";

const SLUG = "acme";

describe("resolveOrgFileBrowsePath", () => {
  it("maps the org home folder to the home volume", () => {
    expect(resolveOrgFileBrowsePath("org/acme/MEMORY.md", SLUG)).toBe(
      "home/MEMORY.md",
    );
    expect(
      resolveOrgFileBrowsePath("org/acme/decks/q3-launch.html", SLUG),
    ).toBe("home/decks/q3-launch.html");
    expect(resolveOrgFileBrowsePath("org/acme/users/u_1/MEMORY.md", SLUG)).toBe(
      "home/users/u_1/MEMORY.md",
    );
  });

  it("maps the slug-reserved `home` fallback", () => {
    expect(resolveOrgFileBrowsePath("org/home/notes/x.md", SLUG)).toBe(
      "home/notes/x.md",
    );
  });

  it("maps public sets, preserving the public/<set> prefix", () => {
    expect(
      resolveOrgFileBrowsePath("org/public/core/skills/index.ts", SLUG),
    ).toBe("public/core/skills/index.ts");
  });

  it("strips a trailing :line(:col) citation", () => {
    expect(resolveOrgFileBrowsePath("org/acme/src/x.ts:42", SLUG)).toBe(
      "home/src/x.ts",
    );
    expect(resolveOrgFileBrowsePath("org/acme/src/x.ts:42:7", SLUG)).toBe(
      "home/src/x.ts",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolveOrgFileBrowsePath("  org/acme/a.md  ", SLUG)).toBe(
      "home/a.md",
    );
  });

  it("resolves thread-scoped output/upload mounts against the thread's subtree", () => {
    expect(resolveOrgFileBrowsePath("org/output/report.md", SLUG, "t_1")).toBe(
      "outputs/t_1/report.md",
    );
    expect(
      resolveOrgFileBrowsePath("org/output/sub/deck.html", SLUG, "t_1"),
    ).toBe("outputs/t_1/sub/deck.html");
    expect(resolveOrgFileBrowsePath("org/upload/report.pdf", SLUG, "t_1")).toBe(
      "uploads/t_1/report.pdf",
    );
  });

  it("leaves output/upload unlinked without a thread id", () => {
    expect(resolveOrgFileBrowsePath("org/upload/report.pdf", SLUG)).toBeNull();
    expect(resolveOrgFileBrowsePath("org/output/deck.html", SLUG)).toBeNull();
  });

  it("skips directories and extension-less basenames", () => {
    expect(resolveOrgFileBrowsePath("org/acme/notes", SLUG)).toBeNull();
    expect(resolveOrgFileBrowsePath("org/acme/notes/", SLUG)).toBeNull();
    expect(resolveOrgFileBrowsePath("org/public/core", SLUG)).toBeNull();
  });

  it("skips unknown top-level volumes and non-org text", () => {
    expect(resolveOrgFileBrowsePath("org/other/x.md", SLUG)).toBeNull();
    expect(resolveOrgFileBrowsePath("src/index.ts", SLUG)).toBeNull();
    expect(resolveOrgFileBrowsePath("https://x.com/a.md", SLUG)).toBeNull();
    // multi-word prose that merely contains a path is not a single token
    expect(
      resolveOrgFileBrowsePath("see org/acme/a.md please", SLUG),
    ).toBeNull();
  });

  it("does not link the org/<slug> home root when the slug is unknown", () => {
    expect(resolveOrgFileBrowsePath("org/acme/a.md", undefined)).toBeNull();
    // but home/ and public/ are slug-independent and still resolve
    expect(resolveOrgFileBrowsePath("org/home/a.md", undefined)).toBe(
      "home/a.md",
    );
  });

  it("requires an in-volume file (bare home/public roots are not links)", () => {
    expect(resolveOrgFileBrowsePath("org/acme", SLUG)).toBeNull();
    expect(resolveOrgFileBrowsePath("org/acme/", SLUG)).toBeNull();
  });
});
