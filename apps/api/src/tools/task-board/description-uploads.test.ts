import { describe, expect, it } from "bun:test";
import {
  sandboxUploadHint,
  uploadsAsSandboxPaths,
} from "./description-uploads";

describe("uploadsAsSandboxPaths", () => {
  it("points an editor image at its sandbox mount", () => {
    // Verbatim shape the markdown editor writes (DANI-19's description).
    expect(
      uploadsAsSandboxPaths(
        "![image.png](/api/daniela-tombini/fs/uploads/read?path=editor-images%2Fc0aa15c2.png)",
      ),
    ).toBe("![image.png](org/.uploads/editor-images/c0aa15c2.png)");
  });

  it("rewrites every upload in the description, not just the first", () => {
    const out = uploadsAsSandboxPaths(
      "![a](/api/o/fs/uploads/read?path=editor-images%2Fa.png)\n\n" +
        "[spec.pdf](/api/o/fs/uploads/read?path=editor-files%2Fspec.pdf)",
    );
    expect(out).toBe(
      "![a](org/.uploads/editor-images/a.png)\n\n" +
        "[spec.pdf](org/.uploads/editor-files/spec.pdf)",
    );
  });

  it("maps each volume to its own mount point", () => {
    expect(uploadsAsSandboxPaths("(/api/o/fs/home/read?path=notes.md)")).toBe(
      "(org/home/notes.md)",
    );
    expect(
      uploadsAsSandboxPaths("(/api/o/fs/outputs/read?path=t1/x.png)"),
    ).toBe("(org/.outputs/t1/x.png)");
  });

  it("leaves a path that could climb out of the mount alone", () => {
    for (const path of [
      "..%2F..%2Fetc%2Fpasswd",
      "%2Fetc%2Fpasswd",
      "%E0%A4",
    ]) {
      const url = `![x](/api/o/fs/uploads/read?path=${path})`;
      expect(uploadsAsSandboxPaths(url)).toBe(url);
    }
  });

  it("leaves everything that isn't an org-fs read URL alone", () => {
    const md =
      "See ![x](https://example.com/a.png) and /api/o/fs/uploads/read (no path)";
    expect(uploadsAsSandboxPaths(md)).toBe(md);
  });
});

describe("sandboxUploadHint", () => {
  it("is null when the rewrite changed nothing", () => {
    const md = "Just plain text, no uploads.";
    expect(sandboxUploadHint(md, uploadsAsSandboxPaths(md))).toBeNull();
  });

  it("fires when the rewrite pointed a link at the sandbox mount", () => {
    const md = "![x](/api/o/fs/uploads/read?path=a.png)";
    expect(sandboxUploadHint(md, uploadsAsSandboxPaths(md))).toContain(
      "real paths in this sandbox",
    );
  });
});
