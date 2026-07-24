import { describe, expect, it } from "bun:test";
import { contentBlocksToTiptapDoc } from "./content-blocks.ts";

describe("contentBlocksToTiptapDoc", () => {
  it("returns empty doc for empty content array", () => {
    const doc = contentBlocksToTiptapDoc([]);
    expect(doc).toEqual({ type: "doc", content: [] });
  });

  it("converts text block to paragraph", () => {
    const doc = contentBlocksToTiptapDoc([{ type: "text", text: "hello" }]);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("preserves leading/trailing whitespace in text but skips whitespace-only", () => {
    const doc = contentBlocksToTiptapDoc([
      { type: "text", text: "  spaced  " },
      { type: "text", text: "   " },
    ]);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "  spaced  " }],
    });
  });

  it("converts image block to file node in paragraph", () => {
    const doc = contentBlocksToTiptapDoc([
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
    expect(doc.content).toHaveLength(1);
    const fileNode = doc.content[0]?.content?.[0];
    expect(fileNode?.type).toBe("file");
    expect(fileNode?.attrs?.name).toBe("image.png");
    expect(fileNode?.attrs?.mimeType).toBe("image/png");
    expect(fileNode?.attrs?.data).toBe("aGVsbG8=");
    expect(fileNode?.attrs?.size).toBe(Math.ceil(("aGVsbG8=".length * 3) / 4));
    expect(typeof fileNode?.attrs?.id).toBe("string");
  });

  it("converts audio block to file node in paragraph", () => {
    const doc = contentBlocksToTiptapDoc([
      { type: "audio", data: "AAAA", mimeType: "audio/mp3" },
    ]);
    expect(doc.content).toHaveLength(1);
    const fileNode = doc.content[0]?.content?.[0];
    expect(fileNode?.type).toBe("file");
    expect(fileNode?.attrs?.name).toBe("audio.mp3");
    expect(fileNode?.attrs?.mimeType).toBe("audio/mp3");
  });

  it("skips image block without data or mimeType", () => {
    const doc = contentBlocksToTiptapDoc([
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", data: "aGVsbG8=", mimeType: "" },
    ] as never);
    expect(doc.content).toHaveLength(0);
  });

  it("converts resource with text to paragraph", () => {
    const doc = contentBlocksToTiptapDoc([
      {
        type: "resource",
        resource: { uri: "file:///test.txt", text: "file content" },
      },
    ]);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "file content" }],
    });
  });

  it("converts resource with blob to file node", () => {
    const doc = contentBlocksToTiptapDoc([
      {
        type: "resource",
        resource: {
          uri: "file:///image.png",
          blob: "aGVsbG8=",
          mimeType: "image/png",
        },
      },
    ]);
    expect(doc.content).toHaveLength(1);
    const fileNode = doc.content[0]?.content?.[0];
    expect(fileNode?.type).toBe("file");
    expect(fileNode?.attrs?.name).toBe("file:///image.png");
    expect(fileNode?.attrs?.mimeType).toBe("image/png");
    expect(fileNode?.attrs?.data).toBe("aGVsbG8=");
  });

  it("defaults mimeType to application/octet-stream for blob without mimeType", () => {
    const doc = contentBlocksToTiptapDoc([
      {
        type: "resource",
        resource: { uri: "file:///data.bin", blob: "AAAA" },
      },
    ]);
    const fileNode = doc.content[0]?.content?.[0];
    expect(fileNode?.attrs?.mimeType).toBe("application/octet-stream");
  });

  it("skips resource with neither text nor blob", () => {
    const doc = contentBlocksToTiptapDoc([
      { type: "resource", resource: { uri: "file:///empty" } },
    ] as never);
    expect(doc.content).toHaveLength(0);
  });

  it("converts resource_link to text paragraph with name", () => {
    const doc = contentBlocksToTiptapDoc([
      { type: "resource_link", uri: "https://example.com", name: "Example" },
    ] as never);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Example" }],
    });
  });

  it("falls back to uri when resource_link has no name", () => {
    const doc = contentBlocksToTiptapDoc([
      { type: "resource_link", uri: "https://example.com" },
    ] as never);
    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "https://example.com" }],
    });
  });

  it("handles mixed content types in order", () => {
    const doc = contentBlocksToTiptapDoc([
      { type: "text", text: "first" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
      { type: "text", text: "last" },
    ]);
    expect(doc.content).toHaveLength(3);
    expect(doc.content[0]?.content?.[0]?.text).toBe("first");
    expect(doc.content[1]?.content?.[0]?.type).toBe("file");
    expect(doc.content[2]?.content?.[0]?.text).toBe("last");
  });
});
