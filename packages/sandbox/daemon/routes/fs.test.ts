import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  makeReadHandler,
  makeWriteHandler,
  makeEditHandler,
  makeGrepHandler,
  makeGlobHandler,
} from "./fs";

const hasRg = spawnSync("which", ["rg"]).status === 0;

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

function post(path: string, obj: unknown): Request {
  return new Request(`http://x${path}`, { method: "POST", body: b64(obj) });
}

describe("fs handlers", () => {
  let appRoot = "";
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "fs-handlers-"));
  });
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true });
  });

  it("read: returns numbered content for text", async () => {
    writeFileSync(join(appRoot, "a.txt"), "one\ntwo\nthree\n");
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_decopilot_vm/read", { path: "a.txt" }));
    const body = (await res.json()) as {
      kind: string;
      content: string;
      lineCount: number;
    };
    expect(body.kind).toBe("text");
    expect(body.content).toContain("1\tone");
    expect(body.content).toContain("3\tthree");
    expect(body.lineCount).toBeGreaterThanOrEqual(3);
  });

  it("read: returns base64 + mediaType for jpeg", async () => {
    // Minimal JPEG: SOI + EOI markers, enough to pass the magic-byte sniff.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    writeFileSync(join(appRoot, "img.jpg"), jpeg);
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_decopilot_vm/read", { path: "img.jpg" }));
    const body = (await res.json()) as {
      kind: string;
      mediaType: string;
      base64: string;
      size: number;
    };
    expect(body.kind).toBe("image");
    expect(body.mediaType).toBe("image/jpeg");
    expect(body.size).toBe(jpeg.length);
    expect(Buffer.from(body.base64, "base64")).toEqual(jpeg);
  });

  it("read: returns base64 + mediaType for png", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    writeFileSync(join(appRoot, "img.png"), png);
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_decopilot_vm/read", { path: "img.png" }));
    const body = (await res.json()) as { kind: string; mediaType: string };
    expect(body.kind).toBe("image");
    expect(body.mediaType).toBe("image/png");
  });

  it("read: rejects non-image binary files", async () => {
    writeFileSync(join(appRoot, "bin"), Buffer.from([0, 1, 2, 3]));
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_decopilot_vm/read", { path: "bin" }));
    expect(res.status).toBe(400);
  });

  it("read: rejects relative path escape", async () => {
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_decopilot_vm/read", { path: "../etc/passwd" }));
    expect(res.status).toBe(400);
  });

  it("read: accepts absolute paths", async () => {
    writeFileSync(join(appRoot, "abs.txt"), "hello");
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_decopilot_vm/read", { path: join(appRoot, "abs.txt") }),
    );
    const body = (await res.json()) as { kind: string; content: string };
    expect(body.kind).toBe("text");
    expect(body.content).toContain("hello");
  });

  it("write: creates file and returns byte count", async () => {
    const h = makeWriteHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_decopilot_vm/write", { path: "new.txt", content: "hello" }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(appRoot, "new.txt"), "utf-8")).toBe("hello");
  });

  it("edit: rejects when old_string doesn't match", async () => {
    writeFileSync(join(appRoot, "e.txt"), "abc");
    const h = makeEditHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_decopilot_vm/edit", {
        path: "e.txt",
        old_string: "xyz",
        new_string: "q",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("edit: rejects multi-match without replace_all", async () => {
    writeFileSync(join(appRoot, "e.txt"), "a a a");
    const h = makeEditHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_decopilot_vm/edit", {
        path: "e.txt",
        old_string: "a",
        new_string: "b",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("edit: applies replace_all", async () => {
    writeFileSync(join(appRoot, "e.txt"), "a a a");
    const h = makeEditHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_decopilot_vm/edit", {
        path: "e.txt",
        old_string: "a",
        new_string: "b",
        replace_all: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(appRoot, "e.txt"), "utf-8")).toBe("b b b");
  });

  (hasRg ? it : it.skip)("grep: returns matching content lines", async () => {
    writeFileSync(join(appRoot, "needle.txt"), "hello world\n");
    const h = makeGrepHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_decopilot_vm/grep", {
        pattern: "hello",
        output_mode: "content",
      }),
    );
    const body = (await res.json()) as { results: string };
    expect(body.results).toContain("hello world");
  });

  (hasRg ? it : it.skip)("glob: returns matching file names", async () => {
    writeFileSync(join(appRoot, "x.txt"), "");
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_decopilot_vm/glob", { pattern: "*.txt" }));
    const body = (await res.json()) as { files: string[] };
    expect(body.files).toContain("x.txt");
  });
});
