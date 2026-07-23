import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/**
 * Regression test for the voice-transcript insertion path in
 * TiptapInputHandle.syncVoiceText: it must insert the transcript as a
 * plain-text JSON node, not a string, since `insertContent(string)`
 * parses its argument as HTML and would reformat/restructure a
 * transcript containing tag-like substrings.
 */
describe("voice transcript insertion", () => {
  const TAG_LIKE_TRANSCRIPTS = [
    "please say <b>bold</b> now",
    "<em onmouseover=alert(1)>hover</em>",
    "list: <ul><li>one</li></ul> done",
  ];

  for (const text of TAG_LIKE_TRANSCRIPTS) {
    test(`preserves literal text for: ${text}`, () => {
      const editor = new Editor({
        extensions: [StarterKit],
        content: { type: "doc", content: [] },
      });
      editor.commands.insertContent({ type: "text", text });
      expect(editor.getText()).toBe(text);
    });
  }
});
