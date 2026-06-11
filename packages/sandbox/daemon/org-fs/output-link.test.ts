import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { repointOutputLink } from "./output-link";

describe("repointOutputLink", () => {
  let appRoot: string;
  const outputs = () => join(appRoot, "org", ".outputs");
  const link = () => join(appRoot, "org", "output");

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "orgfs-out-"));
    mkdirSync(outputs(), { recursive: true });
  });
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true });
  });

  it("creates the thread dir and a relative symlink", async () => {
    expect(await repointOutputLink(appRoot, "thread-1")).toBe(true);
    expect((await lstat(join(outputs(), "thread-1"))).isDirectory()).toBe(true);
    expect(await readlink(link())).toBe(join(".outputs", "thread-1"));
  });

  it("repoints to a new thread and is idempotent for the same one", async () => {
    await repointOutputLink(appRoot, "t1");
    await repointOutputLink(appRoot, "t2");
    expect(await readlink(link())).toBe(join(".outputs", "t2"));
    expect(await repointOutputLink(appRoot, "t2")).toBe(true);
    expect(await readlink(link())).toBe(join(".outputs", "t2"));
  });

  it("rejects traversal / multi-segment / hidden threadIds", async () => {
    const logged: string[] = [];
    for (const bad of ["../evil", "a/b", "..", ".hidden", ""]) {
      expect(await repointOutputLink(appRoot, bad, (m) => logged.push(m))).toBe(
        false,
      );
    }
    await expect(lstat(link())).rejects.toThrow(); // no link created
    expect(logged.length).toBe(5);
  });

  it("is a no-op when the outputs mount dir is missing", async () => {
    rmSync(outputs(), { recursive: true });
    expect(await repointOutputLink(appRoot, "t1")).toBe(false);
    await expect(lstat(link())).rejects.toThrow();
    await expect(lstat(join(outputs(), "t1"))).rejects.toThrow();
  });

  it("refuses to clobber a non-symlink at org/output", async () => {
    writeFileSync(link(), "real file");
    const logged: string[] = [];
    expect(await repointOutputLink(appRoot, "t1", (m) => logged.push(m))).toBe(
      false,
    );
    expect((await lstat(link())).isFile()).toBe(true);
    expect(logged[0]).toContain("not a symlink");
  });
});
