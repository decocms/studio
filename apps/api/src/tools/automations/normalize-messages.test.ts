import { describe, expect, it } from "bun:test";
import { normalizeMessages } from "./normalize-messages";

describe("normalizeMessages", () => {
  it("gives the editor one paragraph per line, so a multi-line prompt survives a save", () => {
    const [message] = normalizeMessages("# Do it\n\nThen report.");
    expect(message?.parts).toEqual([
      { type: "text", text: "# Do it\n\nThen report." },
    ]);
    expect(message?.metadata).toEqual({
      tiptapDoc: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "# Do it" }] },
          { type: "paragraph" },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Then report." }],
          },
        ],
      },
    });
  });

  it("keeps a doc the message already has", () => {
    const doc = { type: "doc", content: [] };
    const [message] = normalizeMessages([
      {
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { tiptapDoc: doc },
      },
    ]);
    expect(message?.metadata).toEqual({ tiptapDoc: doc });
  });
});
