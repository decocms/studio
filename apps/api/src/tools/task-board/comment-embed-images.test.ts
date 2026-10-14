/**
 * The QA reviewer writes screenshots to `/app/org/output/…` (older runs: the
 * relative `org/output/…`) and references them as markdown images;
 * `TASK_BOARD_COMMENT_CREATE` rewrites those refs to the org-fs `outputs` read
 * URL (scoped to the run's thread) so they render inline. It must touch ONLY
 * output image refs — never an external URL, never plain text.
 */
import { describe, expect, it } from "bun:test";
import { embedOrgOutputImages } from "./comments";

const THREAD = "thrd_abc";
const SLUG = "acme";

describe("embedOrgOutputImages", () => {
  it("rewrites an org/output image ref to the thread-scoped outputs URL", () => {
    expect(
      embedOrgOutputImages(
        "![before desktop](org/output/qa/before-desktop.png)",
        THREAD,
        SLUG,
      ),
    ).toBe(
      "![before desktop](/api/acme/fs/outputs/read?path=thrd_abc%2Fqa%2Fbefore-desktop.png)",
    );
  });

  it("rewrites an absolute /app/org/output image ref", () => {
    expect(
      embedOrgOutputImages(
        "![before desktop](/app/org/output/qa/before-desktop.png)",
        THREAD,
        SLUG,
      ),
    ).toBe(
      "![before desktop](/api/acme/fs/outputs/read?path=thrd_abc%2Fqa%2Fbefore-desktop.png)",
    );
  });

  it("rewrites absolute and legacy refs mixed in one body", () => {
    const out = embedOrgOutputImages(
      "![b](/app/org/output/qa/b.png) ![a](org/output/qa/a.png)",
      THREAD,
      SLUG,
    );
    expect(out).toBe(
      "![b](/api/acme/fs/outputs/read?path=thrd_abc%2Fqa%2Fb.png) ![a](/api/acme/fs/outputs/read?path=thrd_abc%2Fqa%2Fa.png)",
    );
  });

  it("leaves other org dirs and repo paths untouched", () => {
    for (const body of [
      "![x](/app/org/home/x.png)",
      "![x](org/upload/x.png)",
      "![x](/app/repo/org/output/x.png)",
      "![x](output/x.png)",
    ]) {
      expect(embedOrgOutputImages(body, THREAD, SLUG)).toBe(body);
    }
  });

  it("rewrites every ref in a multi-line body", () => {
    const out = embedOrgOutputImages(
      "before: ![b](org/output/qa/b.png)\nafter: ![a](org/output/qa/a.png)",
      THREAD,
      SLUG,
    );
    expect(out).toContain("path=thrd_abc%2Fqa%2Fb.png");
    expect(out).toContain("path=thrd_abc%2Fqa%2Fa.png");
  });

  it("rewrites both refs in a single before/after table row", () => {
    const out = embedOrgOutputImages(
      "| Before | After |\n| --- | --- |\n| ![b](org/output/qa/b.png) | ![a](org/output/qa/a.png) |",
      THREAD,
      SLUG,
    );
    expect(out).toContain("path=thrd_abc%2Fqa%2Fb.png");
    expect(out).toContain("path=thrd_abc%2Fqa%2Fa.png");
  });

  it("leaves an external image URL untouched", () => {
    const body = "![x](https://example.com/x.png)";
    expect(embedOrgOutputImages(body, THREAD, SLUG)).toBe(body);
  });

  it("leaves a plain-text mention of a filename untouched (only markdown images)", () => {
    const body = "see /app/org/output/qa/before.png";
    expect(embedOrgOutputImages(body, THREAD, SLUG)).toBe(body);
  });

  it("url-encodes the org slug", () => {
    expect(
      embedOrgOutputImages("![b](org/output/b.png)", THREAD, "a b"),
    ).toContain("/api/a%20b/fs/outputs/read?path=thrd_abc%2Fb.png");
  });
});
