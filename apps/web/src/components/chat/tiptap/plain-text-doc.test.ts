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

  // The chat renders a skill mention with a label line and a
  // `<skill-file path=…>` wrapper around each file. Right for a message, wrong
  // for a prompt someone is about to read and edit — and the frontmatter is
  // catalog metadata, not instructions to anyone.
  it("bakes a skill as its body, without the chat envelope", () => {
    const text = tiptapDocToPlainText({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                char: "/",
                name: "jira-review",
                kind: "skill",
                metadata: {
                  files: [
                    {
                      relPath: "SKILL.md",
                      content:
                        "---\nname: jira-review\ndescription: d\ndisable-model-invocation: true\n---\n\n# Review\n\nFind the pull request.\n",
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    });
    expect(text).toBe("# Review\n\nFind the pull request.");
    expect(text).not.toContain("skill-file");
    expect(text).not.toContain("disable-model-invocation");
    expect(text).not.toContain("/jira-review");
  });

  // A prompt or resource mention has no content in the doc, so the label is
  // the only honest thing to leave behind.
  it("leaves a non-skill mention as its label", () => {
    expect(
      tiptapDocToPlainText({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "run " },
              { type: "mention", attrs: { char: "/", name: "deploy" } },
            ],
          },
        ],
      }),
    ).toBe("run /deploy");
  });
});
