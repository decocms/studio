import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachedFilePaths,
  imageBlocksFromUserMessage,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGE_BYTES,
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
    realpath: (path) => path,
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

  test("reads lines that end in CRLF", () => {
    expect(
      attachedFilePaths(
        "- a.png: /app/org/upload/a.png (tool URL: x)\r\n\r\nlook",
      ),
    ).toEqual([{ name: "a.png", path: "/app/org/upload/a.png" }]);
  });

  test("a line needs a name, a path past the folder and a closed tool URL", () => {
    for (const line of [
      "- : /app/org/upload/a.png (tool URL: x)",
      "- a.png: /app/org/upload/ (tool URL: x)",
      "- a.png: /app/org/upload/a.png (tool URL: x",
      "- a.png: /app/org/upload/a.png",
      "a.png: /app/org/upload/a.png (tool URL: x)",
    ]) {
      expect(attachedFilePaths(line)).toEqual([]);
    }
  });

  test("a long line of repeated markers is scanned in linear time", () => {
    const line = `- a${": /app/org/upload/a (tool URL: ".repeat(200_000)}`;
    const startedAt = performance.now();
    expect(attachedFilePaths(line)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
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
      realpath: (path) => path,
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

  test("images that fit one by one but not together stop at the total ceiling", () => {
    const each = Math.floor(MAX_TOTAL_IMAGE_BYTES * 0.3);
    expect(each).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const large = new Uint8Array(each);
    large.set(PNG);
    const names = ["a.png", "b.png", "c.png", "d.png", "small.png"];
    const files = disk({
      ...Object.fromEntries(
        names.slice(0, 4).map((name) => [`/app/org/upload/${name}`, large]),
      ),
      "/app/org/upload/small.png": PNG,
    });
    const blocks = imageBlocksFromUserMessage(
      message(
        names,
        names.map((filename) => ({ filename, mediaType: "image/png" })),
      ),
      files,
    );
    expect(blocks).toHaveLength(3);
    expect(files.reads).not.toContain("/app/org/upload/small.png");
  });
});

describe("imageBlocksFromUserMessage on a real uploads directory", () => {
  let root = "";
  const onDisk = (path: string) =>
    path.replace(/^\/app\/org\/upload/, join(root, "upload"));
  const files: ReadFile = {
    realpath: (path) => realpathSync(onDisk(path)),
    size: (path) => statSync(onDisk(path)).size,
    read: (path) => readFileSync(onDisk(path)),
  };
  const attached = (name: string, path: string) => ({
    parts: [
      { type: "text", text: `- ${name}: ${path} (tool URL: x)\n\nlook` },
      { type: "file", url: "x", filename: name, mediaType: "image/png" },
    ],
  });

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "image-blocks-")));
    mkdirSync(join(root, "upload"));
    writeFileSync(join(root, "upload", "in.png"), PNG);
    writeFileSync(join(root, "secret.png"), PNG);
    symlinkSync(
      join(root, "upload", "in.png"),
      join(root, "upload", "alias.png"),
    );
    symlinkSync(join(root, "secret.png"), join(root, "upload", "escape.png"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a file inside it is sent, directly or through a symlink that stays inside", () => {
    for (const name of ["in.png", "alias.png"]) {
      expect(
        imageBlocksFromUserMessage(
          attached(name, `/app/org/upload/${name}`),
          files,
        ),
      ).toHaveLength(1);
    }
  });

  test("a `..` path that leaves it is skipped", () => {
    expect(
      imageBlocksFromUserMessage(
        attached("secret.png", "/app/org/upload/../secret.png"),
        files,
      ),
    ).toEqual([]);
  });

  test("a symlink pointing outside it is skipped", () => {
    expect(
      imageBlocksFromUserMessage(
        attached("escape.png", "/app/org/upload/escape.png"),
        files,
      ),
    ).toEqual([]);
  });
});
