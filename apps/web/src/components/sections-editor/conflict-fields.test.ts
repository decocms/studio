import { describe, expect, it } from "bun:test";
import { describeConflictFields } from "./conflict-fields";

describe("describeConflictFields", () => {
  it("reads nested pointers with 1-based positions", () => {
    expect(describeConflictFields(["/slides/0/title"])).toBe(
      "slides › 1 › title",
    );
  });

  it("unescapes keys", () => {
    expect(describeConflictFields(["/a~1b~0c"])).toBe("a/b~c");
  });

  it("lists three and counts the rest", () => {
    expect(describeConflictFields(["/a", "/b", "/c", "/d", "/e"])).toBe(
      "a, b, c (+2)",
    );
  });

  it("collapses duplicates and names the whole value", () => {
    expect(describeConflictFields(["/a", "/a", ""])).toBe("a, *");
  });
});
