/**
 * Which markdown image refs become Jira attachments.
 *
 * Only the run's own `org/output/…` outputs are ours to upload; anything else
 * is somebody's URL and stays a link. The traversal guard matters because the
 * subpath is joined onto the run's thread prefix — `..` would read another
 * run's screenshots onto this customer's issue.
 */
import { describe, expect, it } from "bun:test";
import { attachmentNameFor, outputSubpath } from "./comment-images";

describe("outputSubpath", () => {
  it("takes the subpath of an org/output ref", () => {
    expect(outputSubpath("org/output/qa/before.png")).toBe("qa/before.png");
    expect(outputSubpath("org/output/a.png")).toBe("a.png");
  });

  it("refuses anything that is not ours to upload", () => {
    for (const target of [
      "https://example.com/a.png",
      "/api/acme/fs/outputs/read?path=x",
      "output/a.png",
      "org/outputs/a.png",
      "org/output/",
      "org/output/   ",
    ]) {
      expect(outputSubpath(target)).toBeNull();
    }
  });

  // The subpath is joined onto `<threadId>/`, so traversal would reach another
  // run's outputs — and put them on a customer's issue.
  it("refuses traversal out of the run's own prefix", () => {
    expect(outputSubpath("org/output/../../secrets.png")).toBeNull();
    expect(outputSubpath("org/output/qa/../../../x.png")).toBeNull();
  });
});

describe("attachmentNameFor", () => {
  it("flattens a subpath into one safe filename", () => {
    expect(attachmentNameFor("qa/before-desktop.png")).toBe(
      "qa-before-desktop.png",
    );
    expect(attachmentNameFor("a b/c.png")).toBe("a-b-c.png");
  });

  it("never yields an empty name", () => {
    expect(attachmentNameFor("///")).toBe("image");
  });
});
