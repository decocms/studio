import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { markdownEditorExtensions } from "./extensions";
import { unwrapListContinuations } from "./unwrap-list-continuations";

const WITH_TABLE = `## Contexto

| Onde | String |
| --- | --- |
| Banner | aceitar |
`;

function updates(content: string, drive: (editor: Editor) => void) {
  const seen: { docChanged: boolean; steps: number }[] = [];
  const editor = new Editor({
    extensions: markdownEditorExtensions(),
    content: unwrapListContinuations(content),
    contentType: "markdown",
    onUpdate: ({ transaction }) =>
      seen.push({
        docChanged: transaction.docChanged,
        steps: transaction.steps.length,
      }),
  });
  drive(editor);
  return seen;
}

describe("a caret is not an edit", () => {
  test("focus fires onUpdate on content the schema had to reshape", () => {
    expect(updates(WITH_TABLE, (e) => e.commands.focus())).toEqual([
      { docChanged: false, steps: 0 },
    ]);
  });

  test("and does not on content that parsed cleanly", () => {
    expect(updates("hello", (e) => e.commands.focus())).toEqual([]);
  });

  test("a real edit always does", () => {
    expect(updates("hello", (e) => e.commands.insertContent("!"))).toEqual([
      { docChanged: true, steps: 1 },
    ]);
  });
});

/**
 * Inverts what this file used to pin. The table was dropped at parse, and that
 * loss was recorded here as accepted rather than left undocumented; the schema
 * now has a node for it, so the same fixture has to come back whole.
 */
describe("what the schema keeps", () => {
  const roundTrip = (markdown: string) =>
    new Editor({
      extensions: markdownEditorExtensions(),
      content: unwrapListContinuations(markdown),
      contentType: "markdown",
    }).getMarkdown();

  test("a table survives with every cell", () => {
    const out = roundTrip(WITH_TABLE);
    expect(out).toContain("## Contexto");
    expect(out).toContain("| Onde");
    expect(out).toContain("| String");
    expect(out).toContain("| Banner");
    expect(out).toContain("| aceitar");
  });

  test("a checklist keeps which boxes are ticked", () => {
    const out = roundTrip("- [ ] traduzir\n- [x] revisar\n");
    expect(out).toContain("- [ ] traduzir");
    expect(out).toContain("- [x] revisar");
  });

  /**
   * The serializer pads cells and spaces blocks its own way, so the first pass
   * rewrites whitespace. That is only tolerable because it settles: were it not
   * idempotent, every edit would rewrite the whole document's whitespace and
   * bury the real change in the timeline.
   */
  test("the whitespace it normalizes settles on the first pass", () => {
    const once = roundTrip(WITH_TABLE);
    expect(roundTrip(once)).toBe(once);
  });

  test("a fenced block's blank lines are not touched", () => {
    const code = "```js\nconst a = 1;\n\nconst b = 2;\n```";
    expect(roundTrip(code)).toBe(code);
  });

  /**
   * An ordered list used to poison every block after it: the nodes were still
   * created, with their inline content dropped, so a real issue body came back
   * with empty headings where its sections had been. A bullet list never did
   * it, and neither did a code block — only the numbered one.
   *
   * Fixed upstream in the parser, which is why this pins the SHAPE rather than
   * a message. Nothing in our code can keep it from coming back on a
   * downgrade, so the assertion has to.
   */
  test("an ordered list does not empty the blocks after it", () => {
    const out = roundTrip("1. um\n2. dois\n\n## Depois\n\ntexto depois\n");
    expect(out).toContain("1. um");
    expect(out).toContain("2. dois");
    expect(out).toContain("## Depois");
    expect(out).toContain("texto depois");
  });

  test("still not when a code block splits the list in two", () => {
    const out = roundTrip(
      "1. um\n\n```js\nvar x = 1;\n```\n\n2. dois\n\n## Depois\n\ntexto\n",
    );
    expect(out).toContain("var x = 1;");
    expect(out).toContain("## Depois");
    expect(out).toContain("texto");
  });
});
