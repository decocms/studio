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

describe("what the schema keeps", () => {
  test("a table is already gone at parse, before anything is saved", () => {
    const editor = new Editor({
      extensions: markdownEditorExtensions(),
      content: unwrapListContinuations(WITH_TABLE),
      contentType: "markdown",
    });
    expect(editor.getMarkdown()).toBe("## Contexto");
  });
});
