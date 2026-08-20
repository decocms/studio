import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { markdownEditorExtensions } from "./extensions";
import { unwrapListContinuations } from "./unwrap-list-continuations";

/**
 * The description is stored as markdown, so the schema's whole contract is the
 * round-trip: what a value parses into, and what the editor writes back.
 *
 * The attachment chip is the sharp edge — it has no markdown syntax of its own
 * (it IS a link), so recognizing one on the way in means overriding the handler
 * that also owns every ordinary link.
 */
function roundTrip(markdown: string): { markdown: string; editor: Editor } {
  const editor = new Editor({
    extensions: markdownEditorExtensions(),
    content: unwrapListContinuations(markdown),
    contentType: "markdown",
  });
  return { markdown: editor.getMarkdown(), editor };
}

const FILE_URL = "/api/acme/fs/uploads/read?path=editor-files%2Fabc.pdf";

describe("markdown editor schema", () => {
  test("a link to an uploaded file becomes an attachment chip", () => {
    const { markdown, editor } = roundTrip(`[spec.pdf](${FILE_URL})`);
    const json = editor.getJSON();
    expect(JSON.stringify(json)).toContain('"type":"attachment"');
    // Same markdown back out — the value on the wire never changes shape.
    expect(markdown).toBe(`[spec.pdf](${FILE_URL})`);
  });

  test("an ordinary link stays a link", () => {
    const { markdown, editor } = roundTrip("see [the docs](https://deco.cx/x)");
    expect(JSON.stringify(editor.getJSON())).not.toContain("attachment");
    expect(markdown).toBe("see [the docs](https://deco.cx/x)");
  });

  test("an uploaded image stays an image, not an attachment", () => {
    const url = "/api/acme/fs/uploads/read?path=editor-images%2Fabc.png";
    const { markdown, editor } = roundTrip(`![shot.png](${url})`);
    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain('"type":"image"');
    expect(json).not.toContain("attachment");
    expect(markdown).toBe(`![shot.png](${url})`);
  });

  test("a bracket in the file name survives the round-trip", () => {
    const { markdown, editor } = roundTrip(`[q3 \\[final\\].pdf](${FILE_URL})`);
    expect(JSON.stringify(editor.getJSON())).toContain("q3 [final].pdf");
    expect(markdown).toBe(`[q3 \\[final\\].pdf](${FILE_URL})`);
  });

  // The parser drops a list item's wrapped tail; the normalizer is the guard.
  test("a hard-wrapped list item keeps all of its text", () => {
    const { markdown } = roundTrip(`1. um item que passa da margem
   e continua aqui.
2. outro item.`);
    expect(markdown).toContain("e continua aqui.");
    expect(markdown).toContain("2. outro item.");
  });
});
