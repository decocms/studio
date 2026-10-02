import { describe, expect, it } from "bun:test";
import {
  admitAttachments,
  attachmentStorage,
  commentBodyWithAttachments,
} from "./comment-attachments";

const MB = 1024 * 1024;
const fileOf = (name: string, type: string, bytes: number) =>
  new File([new Uint8Array(bytes)], name, { type });

describe("admitAttachments", () => {
  it("rejects an image over 10 MB and any other file over 25 MB", () => {
    const smallImage = fileOf("shot.png", "image/png", 10 * MB);
    const bigImage = fileOf("huge.png", "image/png", 10 * MB + 1);
    const deck = fileOf("deck.pdf", "application/pdf", 25 * MB);
    const bigDeck = fileOf("big.pdf", "application/pdf", 25 * MB + 1);

    const result = admitAttachments([smallImage, bigImage, deck, bigDeck], 0);

    expect(result.accepted).toEqual([smallImage, deck]);
    expect(result.rejected).toEqual([
      { file: bigImage, reason: "too-large" },
      { file: bigDeck, reason: "too-large" },
    ]);
  });

  it("takes files up to 10 per comment, counting the ones already pending", () => {
    const a = fileOf("a.txt", "text/plain", 1);
    const b = fileOf("b.txt", "text/plain", 1);
    const c = fileOf("c.txt", "text/plain", 1);

    const result = admitAttachments([a, b, c], 8);

    expect(result.accepted).toEqual([a, b]);
    expect(result.rejected).toEqual([{ file: c, reason: "too-many" }]);
  });

  it("an oversized file does not use up a slot", () => {
    const big = fileOf("big.pdf", "application/pdf", 25 * MB + 1);
    const small = fileOf("small.txt", "text/plain", 1);

    const result = admitAttachments([big, small], 9);

    expect(result.accepted).toEqual([small]);
    expect(result.rejected).toEqual([{ file: big, reason: "too-large" }]);
  });
});

describe("commentBodyWithAttachments", () => {
  const shot = { name: "shot.png", url: "/u/a1.png", isImage: true };
  const spec = { name: "spec.pdf", url: "/u/b2.pdf", isImage: false };

  it("puts each attachment after the text, images as images and files as links", () => {
    expect(commentBodyWithAttachments("see attached", [shot, spec])).toBe(
      "see attached\n\n![shot.png](/u/a1.png)\n\n[spec.pdf](/u/b2.pdf)",
    );
  });

  it("is only the attachments when there is no text", () => {
    expect(commentBodyWithAttachments("", [spec])).toBe(
      "[spec.pdf](/u/b2.pdf)",
    );
  });

  it("leaves the text alone when nothing is attached", () => {
    expect(commentBodyWithAttachments("ship it", [])).toBe("ship it");
  });

  it("escapes brackets in a file name so the link survives", () => {
    const draft = {
      name: "notes [draft].pdf",
      url: "/u/c3.pdf",
      isImage: false,
    };

    expect(commentBodyWithAttachments("", [draft])).toBe(
      "[notes \\[draft\\].pdf](/u/c3.pdf)",
    );
  });
});

describe("commentBodyWithAttachments names", () => {
  it("escapes what markdown would read as formatting, so the name survives as text", () => {
    const odd = {
      name: "my_notes *v2* `final`.pdf",
      url: "/u/d4.pdf",
      isImage: false,
    };

    expect(commentBodyWithAttachments("", [odd])).toBe(
      "[my\\_notes \\*v2\\* \\`final\\`.pdf](/u/d4.pdf)",
    );
  });
});

describe("attachmentStorage", () => {
  it("keeps an inert file's extension, and shows a raster image inline", () => {
    expect(attachmentStorage(fileOf("shot.png", "image/png", 1))).toEqual({
      extension: ".png",
      inlineImage: true,
    });
    expect(attachmentStorage(fileOf("spec.pdf", "application/pdf", 1))).toEqual(
      { extension: ".pdf", inlineImage: false },
    );
  });

  it("stores what the read route would serve as a live document as plain text, shown as a chip", () => {
    const live = [
      fileOf("report.html", "text/html", 1),
      fileOf("page.HTM", "text/html", 1),
      fileOf("logo.svg", "image/svg+xml", 1),
      fileOf("feed.xml", "application/xml", 1),
      fileOf("doc.xhtml", "application/xhtml+xml", 1),
      // No extension in the name: the type alone would have named it `.svg`.
      fileOf("pasted", "image/svg+xml", 1),
    ];

    for (const file of live) {
      expect(attachmentStorage(file)).toEqual({
        extension: ".txt",
        inlineImage: false,
      });
    }
  });
});
