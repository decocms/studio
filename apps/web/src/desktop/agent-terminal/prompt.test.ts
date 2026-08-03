import { describe, expect, test } from "bun:test";
import {
  appendAppContexts,
  promptContentFromSendMessage,
  promptTextFromSendMessage,
} from "./prompt";

describe("native terminal prompt bridge", () => {
  test("extracts plain text from direct parts", () => {
    expect(
      promptTextFromSendMessage({
        parts: [
          { type: "text", text: "hello " },
          { type: "text", text: "terminal" },
        ],
      }),
    ).toBe("hello terminal");
  });

  test("extracts text from a Tiptap document", () => {
    expect(
      promptTextFromSendMessage({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "ship it" }] },
        ],
      }),
    ).toBe("ship it");
  });

  test("flags binary attachments instead of silently dropping them", () => {
    expect(
      promptContentFromSendMessage({
        parts: [
          { type: "text", text: "inspect this" },
          {
            type: "file",
            url: "data:image/png;base64,AAAA",
            mediaType: "image/png",
          },
        ],
      }),
    ).toEqual({
      text: "inspect this",
      hasUnsupportedAttachments: true,
    });
  });

  test("preserves one-shot app context", () => {
    expect(
      appendAppContexts("fix the button", { preview: "Selected CTA" }),
    ).toBe("fix the button\n\n### App Context: preview\nSelected CTA");
  });
});
