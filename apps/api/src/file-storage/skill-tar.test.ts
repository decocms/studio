import { describe, expect, it } from "bun:test";
import type { OrgFsEntry } from "../storage/org-fs";
import { selectSkillFiles, streamSkillTar, tarHeader } from "./skill-tar";

function file(path: string, size = 10): OrgFsEntry {
  return { path, kind: "file", size } as OrgFsEntry;
}

async function drain(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of s as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(c);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Read the entry names back out of a tar, the way the daemon's reader will. */
function namesIn(tar: Uint8Array): string[] {
  const names: string[] = [];
  const dec = new TextDecoder();
  for (let off = 0; off + 512 <= tar.byteLength; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const cut = (buf: Uint8Array) => {
      const z = buf.indexOf(0);
      return dec.decode(z === -1 ? buf : buf.subarray(0, z));
    };
    const name = cut(header.subarray(0, 100));
    const prefix = cut(header.subarray(345, 500));
    const size = Number.parseInt(cut(header.subarray(124, 136)).trim(), 8);
    names.push(prefix ? `${prefix}/${name}` : name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("selectSkillFiles", () => {
  it("takes only folders holding a SKILL.md, with everything under them", () => {
    const got = selectSkillFiles([
      file("README.md"),
      file(".gitignore"),
      file("slides/SKILL.md"),
      file("slides/bin/run.sh"),
      file("notes/thoughts.md"),
    ]);
    expect(got.map((e) => e.name)).toEqual([
      "slides/SKILL.md",
      "slides/bin/run.sh",
    ]);
    // Codepoint order, so "S" precedes "b" regardless of the server's locale.
  });

  it("ignores a root-level SKILL.md, which is not a skill folder", () => {
    expect(selectSkillFiles([file("SKILL.md")])).toEqual([]);
  });
});

describe("tarHeader", () => {
  it("computes the checksum over the header with the field blanked", () => {
    const h = tarHeader("slides/SKILL.md", 42)!;
    const stated = Number.parseInt(
      new TextDecoder().decode(h.subarray(148, 156)).split("\0")[0]!.trim(),
      8,
    );
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    }
    expect(stated).toBe(sum);
  });

  // Golden bytes. Go's `archive/tar` (the only consumer) accepted this exact
  // layout — verified by writing a real archive with this module and reading it
  // back with the daemon's extractor and with bsdtar. Go's reader is stdlib and
  // will not drift, so pinning the layout here is what keeps THIS side honest:
  // if you change the header, re-run that cross-check before updating this.
  it("emits the exact ustar layout the daemon's reader accepts", () => {
    const h = tarHeader("slides/SKILL.md", 5)!;
    // Tar pads every text field with NUL; take the part before the first one.
    const at = (from: number, to: number) =>
      new TextDecoder().decode(h.subarray(from, to)).split("\0")[0];
    expect(h.byteLength).toBe(512);
    expect(at(0, 100)).toBe("slides/SKILL.md");
    expect(at(100, 108)).toBe("0000644");
    expect(at(124, 136)).toBe("00000000005"); // size, octal
    expect(at(136, 148)).toBe("00000000000"); // mtime, fixed
    expect(at(156, 157)).toBe("0"); // regular file
    expect(at(257, 263)).toBe("ustar");
    expect(at(263, 265)).toBe("00");
    expect(at(345, 500)).toBe(""); // no prefix needed at this length
  });

  it("splits a long path across prefix and name", () => {
    const long = `${"d".repeat(120)}/${"s".repeat(60)}/SKILL.md`;
    const h = tarHeader(long, 1);
    expect(h).not.toBeNull();
    const framed = new Uint8Array(1024);
    framed.set(h!, 0);
    expect(namesIn(framed)[0]).toBe(long);
  });

  it("refuses a path it cannot represent rather than truncating it", () => {
    // No slash in the last 100 chars to split on — a truncated header would
    // silently become a DIFFERENT file on extract.
    expect(tarHeader(`${"x".repeat(300)}.md`, 1)).toBeNull();
  });
});

describe("streamSkillTar", () => {
  const bytes = (n: number) => new Uint8Array(n).fill(65);

  it("round-trips names and sizes, padded to block boundaries", async () => {
    const tar = await drain(
      streamSkillTar({
        entries: [
          { name: "a/SKILL.md", size: 3, sourcePath: "a/SKILL.md" },
          { name: "b/SKILL.md", size: 600, sourcePath: "b/SKILL.md" },
        ],
        read: async (p) => bytes(p.startsWith("a") ? 3 : 600),
        maxBytes: 1 << 20,
      }),
    );
    expect(namesIn(tar)).toEqual(["a/SKILL.md", "b/SKILL.md"]);
    // header+block, header+2 blocks, then the two-block terminator.
    expect(tar.byteLength).toBe(512 * 2 + 512 * 3 + 512 * 2);
  });

  it("skips an unreadable file and still emits the rest", async () => {
    const skipped: string[] = [];
    const tar = await drain(
      streamSkillTar({
        entries: [
          { name: "bad/SKILL.md", size: 1, sourcePath: "bad/SKILL.md" },
          { name: "ok/SKILL.md", size: 1, sourcePath: "ok/SKILL.md" },
        ],
        read: async (p) => {
          if (p.startsWith("bad")) throw new Error("EIO");
          return bytes(1);
        },
        maxBytes: 1 << 20,
        onSkip: (n) => skipped.push(n),
      }),
    );
    expect(namesIn(tar)).toEqual(["ok/SKILL.md"]);
    expect(skipped).toEqual(["bad/SKILL.md"]);
  });

  it("stops at the byte cap instead of streaming a volume unbounded", async () => {
    const skipped: string[] = [];
    const tar = await drain(
      streamSkillTar({
        entries: ["a", "b", "c"].map((n) => ({
          name: `${n}/SKILL.md`,
          size: 400,
          sourcePath: `${n}/SKILL.md`,
        })),
        read: async () => bytes(400),
        maxBytes: 900,
        onSkip: (n, why) => skipped.push(`${n}:${why}`),
      }),
    );
    expect(namesIn(tar)).toEqual(["a/SKILL.md", "b/SKILL.md"]);
    expect(skipped[0]).toContain("cap reached");
  });

  it("terminates cleanly when every entry is unreadable", async () => {
    const tar = await drain(
      streamSkillTar({
        entries: [{ name: "x/SKILL.md", size: 1, sourcePath: "x/SKILL.md" }],
        read: async () => {
          throw new Error("EIO");
        },
        maxBytes: 1 << 20,
      }),
    );
    expect(namesIn(tar)).toEqual([]);
    expect(tar.byteLength).toBe(1024);
  });
});
