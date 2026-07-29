import { describe, expect, it } from "bun:test";
import {
  basename,
  browsePathFor,
  parseLibraryPath,
  segmentLabel,
} from "./location";

describe("parseLibraryPath", () => {
  it("parses the empty path (not UI-reachable, but still valid)", () => {
    const loc = parseLibraryPath("");
    expect(loc.volume).toBeNull();
    expect(loc.dirPath).toBe("");
    expect(loc.isPublic).toBe(false);
    expect(loc.readOnly).toBe(false);
    expect(loc.segments).toEqual([]);
    expect(loc.isHomeRoot).toBe(false);
  });

  it("flags only the home volume root as the landing view", () => {
    expect(parseLibraryPath("home").isHomeRoot).toBe(true);
    expect(parseLibraryPath("home/docs").isHomeRoot).toBe(false);
    expect(parseLibraryPath("uploads").isHomeRoot).toBe(false);
  });

  it("parses a volume root", () => {
    const loc = parseLibraryPath("skills");
    expect(loc.volume).toBe("skills");
    expect(loc.dirPath).toBe("");
  });

  it("parses a nested dir", () => {
    const loc = parseLibraryPath("outputs/thread-1/sub");
    expect(loc.volume).toBe("outputs");
    expect(loc.dirPath).toBe("thread-1/sub");
  });

  it("parses the public-sets listing (no volume yet)", () => {
    const loc = parseLibraryPath("public");
    expect(loc.volume).toBeNull();
    expect(loc.isPublic).toBe(true);
    expect(loc.publicSet).toBeNull();
    expect(loc.readOnly).toBe(true);
  });

  it("maps public/<set>/... to the public-<set> volume", () => {
    const loc = parseLibraryPath("public/core/skills/web");
    expect(loc.volume).toBe("public-core");
    expect(loc.dirPath).toBe("skills/web");
    expect(loc.readOnly).toBe(true);
  });

  it("ignores empty segments", () => {
    expect(parseLibraryPath("skills//docs").dirPath).toBe("docs");
  });
});

describe("browsePathFor", () => {
  it("prefixes the volume", () => {
    const loc = parseLibraryPath("skills");
    expect(browsePathFor(loc, "docs/a.txt")).toBe("skills/docs/a.txt");
  });

  it("keeps the public/<set> spelling", () => {
    const loc = parseLibraryPath("public/core");
    expect(browsePathFor(loc, "skills/web")).toBe("public/core/skills/web");
  });
});

describe("segmentLabel", () => {
  it("presents the public volume as skills, everything else as-is", () => {
    expect(segmentLabel("public")).toBe("skills");
    expect(segmentLabel("uploads")).toBe("uploads");
  });
});

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("a/b/c.txt")).toBe("c.txt");
    expect(basename("c.txt")).toBe("c.txt");
  });
});
