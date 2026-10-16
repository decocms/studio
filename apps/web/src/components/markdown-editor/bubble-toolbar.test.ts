import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { markdownEditorExtensions } from "./extensions";
import { shouldShow } from "./bubble-toolbar";

/**
 * A mention is an atom node, selectable like image and attachment — clicking
 * one selects the whole chip, not text inside it, so the formatting toolbar
 * (bold, headings, …) has nothing to act on and must stay hidden.
 */
describe("BubbleToolbar shouldShow", () => {
  test("stays hidden when a mention chip is selected", () => {
    const editor = new Editor({
      extensions: markdownEditorExtensions(),
      content: "ping [@Ana](mention:usr_1) please",
      contentType: "markdown",
    });
    let mentionPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "mention") mentionPos = pos;
    });
    expect(mentionPos).toBeGreaterThanOrEqual(0);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        NodeSelection.create(editor.state.doc, mentionPos),
      ),
    );
    expect(
      shouldShow({
        editor,
        element: editor.view.dom,
        state: editor.state,
        from: 0,
        to: 0,
        view: editor.view,
      }),
    ).toBe(false);
  });

  test("shows for an ordinary text selection", () => {
    const editor = new Editor({
      extensions: markdownEditorExtensions(),
      content: "hello world",
      contentType: "markdown",
    });
    editor.commands.selectAll();
    expect(
      shouldShow({
        editor,
        element: editor.view.dom,
        state: editor.state,
        from: 0,
        to: 0,
        view: editor.view,
      }),
    ).toBe(true);
  });
});
