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

describe("describeConflictFields with the form's schema", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string", title: "Headline" },
      cta: { type: "string" },
      slides: {
        type: "array",
        title: "Slides",
        items: {
          type: "object",
          properties: { title: { type: "string", title: "Slide title" } },
        },
      },
    },
  };

  it("names a field by its label in the form, not its code name", () => {
    expect(describeConflictFields(["/title"], schema)).toBe("Headline");
  });

  it("follows arrays into their items", () => {
    expect(describeConflictFields(["/slides/1/title"], schema)).toBe(
      "Slides › 2 › Slide title",
    );
  });

  it("keeps the key of a field the schema doesn't label", () => {
    expect(describeConflictFields(["/cta", "/extra/0"], schema)).toBe(
      "cta, extra › 1",
    );
  });
});
