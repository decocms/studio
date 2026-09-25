import { describe, expect, it } from "bun:test";
import {
  basename,
  browsePathFor,
  libraryTrail,
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

describe("libraryTrail", () => {
  it("is empty at the root — the root is the place, not a step to it", () => {
    expect(libraryTrail("home", "home")).toEqual([]);
    expect(libraryTrail("home/projects/farm", "home/projects/farm")).toEqual(
      [],
    );
  });

  it("walks the segments below the root", () => {
    expect(libraryTrail("home/decks/q3", "home")).toEqual([
      { label: "decks", path: "home/decks" },
      { label: "q3", path: "home/decks/q3" },
    ]);
  });

  it("a project root hides the folders above it", () => {
    expect(
      libraryTrail("home/projects/farm/decks", "home/projects/farm"),
    ).toEqual([{ label: "decks", path: "home/projects/farm/decks" }]);
  });

  it("labels `public` as skills, like every other segment reader", () => {
    expect(libraryTrail("public/core", "")[0]?.label).toBe("skills");
  });

  /** A breadcrumb that silently empties strands someone in a folder. */
  it("a path outside the root falls back to its own full trail", () => {
    expect(libraryTrail("uploads/docs", "home")).toEqual([
      { label: "uploads", path: "uploads" },
      { label: "docs", path: "uploads/docs" },
    ]);
  });
});
