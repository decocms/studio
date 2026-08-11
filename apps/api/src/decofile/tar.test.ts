import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { extractTarGz } from "./tar";

/** Build a minimal ustar archive (same header shapes GitHub emits). */
function buildTar(
  entries: Array<{ path: string; content?: string; type?: string }>,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const entry of entries) {
    const content = enc.encode(entry.content ?? "");
    const header = new Uint8Array(512);
    header.set(enc.encode(entry.path.slice(0, 100)), 0);
    header.set(enc.encode("0000644\0"), 100);
    header.set(enc.encode("0000000\0"), 108);
    header.set(enc.encode("0000000\0"), 116);
    header.set(
      enc.encode(`${content.length.toString(8).padStart(11, "0")}\0`),
      124,
    );
    header.set(enc.encode("00000000000\0"), 136);
    header.set(enc.encode("        "), 148); // checksum placeholder
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.set(enc.encode("ustar\0"), 257);
    header.set(enc.encode("00"), 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header);
    if (content.length > 0) {
      const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
      padded.set(content);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024)); // end-of-archive
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

describe("extractTarGz", () => {
  it("extracts regular files, stripping the top-level directory", () => {
    const tar = buildTar([
      { path: "owner-repo-abc123/", type: "5" },
      { path: "owner-repo-abc123/.deco/blocks/Hero.json", content: '{"n":1}' },
      { path: "owner-repo-abc123/README.md", content: "hi" },
    ]);
    const files = extractTarGz(gzipSync(tar));
    expect(files.map((f) => f.path)).toEqual([
      ".deco/blocks/Hero.json",
      "README.md",
    ]);
    expect(new TextDecoder().decode(files[0]!.content)).toBe('{"n":1}');
  });

  it("honours a pax path override for long/encoded names", () => {
    const longName = `owner-repo-abc/.deco/blocks/${"x".repeat(120)}.json`;
    // Record length is self-referential: it counts its own digits too.
    const body = ` path=${longName}\n`;
    let len = body.length + 1;
    while (String(len).length + body.length !== len) {
      len = String(len).length + body.length;
    }
    const pax = `${len}${body}`;
    const tar = buildTar([
      { path: "owner-repo-abc/pax-hdr", content: pax, type: "x" },
      { path: "owner-repo-abc/truncated-name.json", content: "{}" },
    ]);
    const files = extractTarGz(gzipSync(tar));
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(`.deco/blocks/${"x".repeat(120)}.json`);
  });

  it("honours a GNU long-name entry", () => {
    const longName = `owner-repo-abc/.deco/blocks/${"y".repeat(150)}.json`;
    const tar = buildTar([
      { path: "././@LongLink", content: longName, type: "L" },
      { path: "owner-repo-abc/short.json", content: "{}" },
    ]);
    const files = extractTarGz(gzipSync(tar));
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(`.deco/blocks/${"y".repeat(150)}.json`);
  });

  it("skips directories and non-file types", () => {
    const tar = buildTar([
      { path: "o-r-a/dir/", type: "5" },
      { path: "o-r-a/link", type: "2", content: "" },
      { path: "o-r-a/file.txt", content: "data" },
    ]);
    const files = extractTarGz(gzipSync(tar));
    expect(files.map((f) => f.path)).toEqual(["file.txt"]);
  });
});
