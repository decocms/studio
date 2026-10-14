import { describe, expect, it } from "bun:test";
import {
  commentUploadsAsSandboxPaths,
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
    ).toBe("![image.png](/app/org/.uploads/editor-images/c0aa15c2.png)");
  });

  it("rewrites every upload in the description, not just the first", () => {
    const out = uploadsAsSandboxPaths(
      "![a](/api/o/fs/uploads/read?path=editor-images%2Fa.png)\n\n" +
        "[spec.pdf](/api/o/fs/uploads/read?path=editor-files%2Fspec.pdf)",
    );
    expect(out).toBe(
      "![a](/app/org/.uploads/editor-images/a.png)\n\n" +
        "[spec.pdf](/app/org/.uploads/editor-files/spec.pdf)",
    );
  });

  it("maps each volume to its own mount point", () => {
    expect(uploadsAsSandboxPaths("(/api/o/fs/home/read?path=notes.md)")).toBe(
      "(/app/org/home/notes.md)",
    );
    expect(
      uploadsAsSandboxPaths("(/api/o/fs/outputs/read?path=t1/x.png)"),
    ).toBe("(/app/org/.outputs/t1/x.png)");
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

describe("sandboxPathsAsUploads", () => {
  it("restores a comment link a run read as a sandbox path and posted back", () => {
    const original =
      "![shot](/api/acme/fs/uploads/read?path=editor-images%2Fa.png)";
    const asListed = commentUploadsAsSandboxPaths(original, "acme");
    expect(asListed).toBe("![shot](/app/org/.uploads/editor-images/a.png)");
    expect(sandboxPathsAsUploads(asListed, "acme")).toBe(original);
  });

  // When the per-run `/app/org/output` link is missing, runs save screenshots
  // through the hidden mount instead — with or without their thread folder.
  it("serves a screenshot saved straight into the outputs mount", () => {
    expect(
      sandboxPathsAsUploads(
        "![after](/app/org/.outputs/thrd_x/qa/after.png)",
        "acme",
      ),
    ).toBe("![after](/api/acme/fs/outputs/read?path=thrd_x%2Fqa%2Fafter.png)");
    expect(
      sandboxPathsAsUploads("![after](/app/org/.outputs/qa/after.png)", "acme"),
    ).toBe("![after](/api/acme/fs/outputs/read?path=qa%2Fafter.png)");
  });

  it("still takes the legacy relative form", () => {
    expect(
      sandboxPathsAsUploads("[spec](org/.uploads/editor-files/s.pdf)", "acme"),
    ).toBe("[spec](/api/acme/fs/uploads/read?path=editor-files%2Fs.pdf)");
  });

  it("rewrites every link in a before/after table row", () => {
    const out = sandboxPathsAsUploads(
      "| ![b](/app/org/.outputs/t/b.png) | ![a](/app/org/.outputs/t/a.png) |",
      "acme",
    );
    expect(out).toBe(
      "| ![b](/api/acme/fs/outputs/read?path=t%2Fb.png) | ![a](/api/acme/fs/outputs/read?path=t%2Fa.png) |",
    );
  });

  it("leaves paths no browser can be pointed at untouched", () => {
    for (const body of [
      "![b](/tmp/qa/b.png)",
      "![b](https://example.com/b.png)",
      "![b](/app/org/.outputs/../secrets.png)",
      "![b](/app/org/.outputs/)",
      "![b](/app/org/home/notes.png)",
      "see /app/org/.outputs/qa/b.png",
    ]) {
      expect(sandboxPathsAsUploads(body, "acme")).toBe(body);
    }
  });

  it("url-encodes the org slug", () => {
    expect(sandboxPathsAsUploads("![b](/app/org/.uploads/b.png)", "a b")).toBe(
      "![b](/api/a%20b/fs/uploads/read?path=b.png)",
    );
  });
});
