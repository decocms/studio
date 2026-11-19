import { describe, expect, test } from "bun:test";
import {
  attachedFilePaths,
  imageBlocksFromUserMessage,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  type ReadFile,
} from "./image-blocks";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function annotation(names: string[]): string {
  return [
    "[Attached files — already inside your sandbox; read them at the given path. The tool URL is only for tools that take a URL argument]",
    ...names.map(
      (name) =>
        `- ${name}: /app/org/upload/${name} (tool URL: studio-storage:uploads/t/${name})`,
    ),
  ].join("\n");
}

function message(
  names: string[],
  files: { filename?: string; mediaType: string }[],
) {
  return {
    parts: [
      { type: "text", text: `${annotation(names)}\n\nwhat is this?` },
      ...files.map((file) => ({
        type: "file",
        url: "https://storage.example/presigned?expires=1",
        ...file,
      })),
    ],
  };
}

function disk(
  contents: Record<string, Uint8Array>,
): ReadFile & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    size: (path) => {
      const bytes = contents[path];
      if (!bytes) throw new Error("ENOENT");
      return bytes.byteLength;
    },
    read: (path) => {
      reads.push(path);
      const bytes = contents[path];
      if (!bytes) throw new Error("ENOENT");
      return bytes;
    },
  };
}

describe("attachedFilePaths", () => {
  test("reads the annotation's in-sandbox paths in order", () => {
    expect(attachedFilePaths(annotation(["a.png", "my shot (2).jpg"]))).toEqual(
      [
        { name: "a.png", path: "/app/org/upload/a.png" },
        { name: "my shot (2).jpg", path: "/app/org/upload/my shot (2).jpg" },
      ],
    );
  });

  test("ignores paths outside the uploads folder", () => {
    expect(
      attachedFilePaths("- x.png: /etc/passwd (tool URL: studio-storage:x)"),
    ).toEqual([]);
  });
});

describe("imageBlocksFromUserMessage", () => {
  test("text only has no blocks", () => {
    expect(
      imageBlocksFromUserMessage(
        { parts: [{ type: "text", text: "hi" }] },
        disk({}),
      ),
    ).toEqual([]);
  });

  test("one image becomes a base64 block read from disk, not the URL", () => {
    const files = disk({ "/app/org/upload/a.png": PNG });
    const blocks = imageBlocksFromUserMessage(
      message(["a.png"], [{ filename: "a.png", mediaType: "image/png" }]),
      files,
    );
    expect(blocks).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(PNG).toString("base64"),
        },
      },
    ]);
    expect(files.reads).toEqual(["/app/org/upload/a.png"]);
  });

  test("several images keep their order, de-duplicated names included", () => {
    const blocks = imageBlocksFromUserMessage(
      message(
        ["shot.png", "shot (2).png", "attachment.jpg"],
        [
          { filename: "shot.png", mediaType: "image/png" },
          { filename: "shot.png", mediaType: "image/png" },
          { mediaType: "image/jpeg" },
        ],
      ),
      disk({
        "/app/org/upload/shot.png": PNG,
        "/app/org/upload/shot (2).png": JPEG,
        "/app/org/upload/attachment.jpg": JPEG,
      }),
    );
    expect(blocks.map((b) => b.source.media_type)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
    ]);
  });

  test("an unsupported type is skipped, by declared type and by its bytes", () => {
    const files = disk({
      "/app/org/upload/a.svg": new TextEncoder().encode("<svg/>"),
      "/app/org/upload/b.pdf": new TextEncoder().encode("%PDF-1.4"),
      "/app/org/upload/c.heic": new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74]),
    });
    expect(
      imageBlocksFromUserMessage(
        message(
          ["a.svg", "b.pdf", "c.heic"],
          [
            { filename: "a.svg", mediaType: "image/svg+xml" },
            { filename: "b.pdf", mediaType: "application/pdf" },
            { filename: "c.heic", mediaType: "image/heic" },
          ],
        ),
        files,
      ),
    ).toEqual([]);
    expect(files.reads).not.toContain("/app/org/upload/b.pdf");
  });

  test("an oversized file is skipped without being read", () => {
    const files: ReadFile & { reads: string[] } = {
      reads: [],
      size: () => MAX_IMAGE_BYTES + 1,
      read(path) {
        this.reads.push(path);
        return PNG;
      },
    };
    expect(
      imageBlocksFromUserMessage(
        message(["big.png"], [{ filename: "big.png", mediaType: "image/png" }]),
        files,
      ),
    ).toEqual([]);
    expect(files.reads).toEqual([]);
  });

  test("a missing file, or one with no path line, is skipped", () => {
    expect(
      imageBlocksFromUserMessage(
        message(
          ["gone.png"],
          [{ filename: "gone.png", mediaType: "image/png" }],
        ),
        disk({}),
      ),
    ).toEqual([]);
    expect(
      imageBlocksFromUserMessage(
        message([], [{ filename: "a.png", mediaType: "image/png" }]),
        disk({ "/app/org/upload/a.png": PNG }),
      ),
    ).toEqual([]);
  });

  test("stops at the per-message ceiling", () => {
    const names = Array.from(
      { length: MAX_IMAGES_PER_MESSAGE + 3 },
      (_, i) => `i${i}.png`,
    );
    const blocks = imageBlocksFromUserMessage(
      message(
        names,
        names.map((filename) => ({ filename, mediaType: "image/png" })),
      ),
      disk(
        Object.fromEntries(
          names.map((name) => [`/app/org/upload/${name}`, PNG]),
        ),
      ),
    );
    expect(blocks).toHaveLength(MAX_IMAGES_PER_MESSAGE);
  });
});
