import { describe, expect, it } from "bun:test";
import { plainTextToTiptapDoc, tiptapDocToPlainText } from "./plain-text-doc";

describe("plain text ↔ tiptap doc", () => {
  // The field stores a string, so what a person typed has to survive being
  // opened and closed without an edit — otherwise every visit rewrites the
  // saved prompt and the diff is noise.
  it("round-trips text unchanged", () => {
    for (const text of [
      "Review the issue.",
      "Line one\nLine two",
      "A paragraph.\n\nAnother one.",
      "- a\n- b\n\n## Heading\n\ntail",
    ]) {
      expect(tiptapDocToPlainText(plainTextToTiptapDoc(text))).toBe(text);
    }
  });

  it("reads an empty field as an empty string, not a stray newline", () => {
    expect(tiptapDocToPlainText(plainTextToTiptapDoc(""))).toBe("");
    expect(tiptapDocToPlainText(undefined)).toBe("");
    expect(tiptapDocToPlainText({ type: "doc", content: [] })).toBe("");
  });

  // A blank line is a paragraph break in markdown, and a skill's body is
  // markdown — collapsing them would run a heading into the line above it.
  it("keeps blank lines as empty paragraphs", () => {
    const doc = plainTextToTiptapDoc("a\n\nb");
    expect(doc.content).toHaveLength(3);
    expect(doc.content[1]).toEqual({ type: "paragraph" });
  });
});
