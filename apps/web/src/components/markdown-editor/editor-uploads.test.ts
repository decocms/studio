import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { insertUpload, pastedAttachments } from "./editor-uploads";
import { markdownEditorExtensions } from "./extensions";

function editorWith(markdown: string): Editor {
  const editor = new Editor({
    extensions: markdownEditorExtensions(),
    content: markdown,
    contentType: "markdown",
  });
  editor.commands.focus("end");
  return editor;
}

/** What the upload loop does for each file of a batch: insert at the caret. */
function attach(
  editor: Editor,
  type: "image" | "attachment",
  name: string,
): void {
  insertUpload(
    editor.view,
    editor.state.selection.to,
    type,
    type === "image"
      ? { src: `/${name}`, alt: name }
      : { href: `/${name}`, name },
  );
}

describe("insertUpload", () => {
  test("files land in the order they were picked, an image first included", () => {
    const editor = editorWith("see");
    attach(editor, "image", "shot.png");
    attach(editor, "attachment", "spec.pdf");
    attach(editor, "attachment", "deck.pptx");

    const markdown = editor.getMarkdown();
    const order = ["see", "shot.png", "spec.pdf", "deck.pptx"].map((s) =>
      markdown.indexOf(s),
    );
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    // Chips that follow each other share a line, as they would in a sentence.
    expect(markdown).toContain("[spec.pdf](/spec.pdf) [deck.pptx](/deck.pptx)");
  });

  test("the words around a chip stay words, not part of its link", () => {
    const editor = editorWith("see");
    attach(editor, "attachment", "spec.pdf");
    editor.commands.insertContent("then");
    expect(editor.getMarkdown()).toContain("see [spec.pdf](/spec.pdf) then");
  });

  test("an image inserted mid-sentence keeps the rest of it below", () => {
    const editor = editorWith("before after");
    editor.commands.setTextSelection(8);
    attach(editor, "image", "shot.png");
    attach(editor, "attachment", "spec.pdf");
    expect(editor.getMarkdown()).toBe(
      "before \n\n![shot.png](/shot.png)\n\n[spec.pdf](/spec.pdf) after",
    );
  });
});

function clipboard(types: Record<string, string>, files: File[]) {
  return { files, getData: (format: string) => types[format] ?? "" };
}

describe("pastedAttachments", () => {
  const png = new File(["png"], "image.png", { type: "image/png" });

  test("a copied file or screenshot is attached", () => {
    expect(pastedAttachments(clipboard({}, [png]))).toEqual([png]);
  });

  test("a browser's Copy Image is attached, though it brings markup", () => {
    const copy = clipboard({ "text/html": '<img src="https://x/a.png">' }, [
      png,
    ]);
    expect(pastedAttachments(copy)).toEqual([png]);
  });

  test("a spreadsheet copy pastes its text, not the picture beside it", () => {
    const copy = clipboard(
      {
        "text/plain": "Q3\t1200",
        "text/html": "<table><tr><td>Q3</td><td>1200</td></tr></table>",
      },
      [png],
    );
    expect(pastedAttachments(copy)).toEqual([]);
  });

  test("plain text alone is not an attachment paste", () => {
    expect(pastedAttachments(clipboard({ "text/plain": "hi" }, []))).toEqual(
      [],
    );
    expect(pastedAttachments(null)).toEqual([]);
  });
});
