import { describe, expect, it } from "bun:test";
import {
  sandboxPathsAsUploads,
  sandboxUploadHint,
  uploadsAsSandboxPaths,
} from "./description-uploads";

describe("uploadsAsSandboxPaths", () => {
  it("points an editor image at its sandbox mount", () => {
    // Verbatim shape the markdown editor writes.
    expect(
      uploadsAsSandboxPaths(
        "![image.png](/api/acme/fs/uploads/read?path=editor-images%2Fc0aa15c2.png)",
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

  it("leaves an encoded-slash volume that could climb out of the mount alone", () => {
    // `..%2F..%2Fetc` decodes to `../../etc` though the raw capture has no slash.
    const url = "(/api/o/fs/..%2F..%2Fetc/read?path=passwd)";
    expect(uploadsAsSandboxPaths(url)).toBe(url);
  });

  it("leaves everything that isn't an org-fs read URL alone", () => {
    const md =
      "See ![x](https://example.com/a.png) and /api/o/fs/uploads/read (no path)";
    expect(uploadsAsSandboxPaths(md)).toBe(md);
  });
});

describe("sandboxPathsAsUploads", () => {
  it("undoes the rewrite, so a body a run reads and writes back still renders", () => {
    const stored =
      "see [spec.pdf](/api/acme/fs/uploads/read?path=editor-files%2Fspec.pdf)\n\n" +
      "![shot.png](/api/acme/fs/uploads/read?path=editor-images%2Fshot.png)";
    expect(sandboxPathsAsUploads(uploadsAsSandboxPaths(stored), "acme")).toBe(
      stored,
    );
  });

  it("maps the hidden outputs mount back to its volume", () => {
    expect(
      sandboxPathsAsUploads("![a](org/.outputs/t1/qa/a.png)", "acme"),
    ).toBe("![a](/api/acme/fs/outputs/read?path=t1%2Fqa%2Fa.png)");
  });

  it("leaves paths with an existing meaning alone", () => {
    for (const md of [
      "[notes](org/home/notes.md)",
      "![run shot](org/output/qa/a.png)",
      "[thread upload](org/upload/a.pdf)",
      "a bare org/.uploads/editor-files/a.pdf in prose",
      "[external](https://example.com/org/.uploads/a.pdf)",
    ]) {
      expect(sandboxPathsAsUploads(md, "acme")).toBe(md);
    }
  });

  it("leaves a target that climbs out of the mount alone", () => {
    for (const md of [
      "[x](org/.uploads/../home/secret.md)",
      "[x](org/.uploads/)",
    ]) {
      expect(sandboxPathsAsUploads(md, "acme")).toBe(md);
    }
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
