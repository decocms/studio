import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeSnapshotCreateHandler,
  makeSnapshotRestoreHandler,
} from "./snapshot";

describe("snapshot handlers", () => {
  let repoDir = "";

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "snapshot-handlers-"));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("create returns 404 when repoDir doesn't exist", async () => {
    const handler = makeSnapshotCreateHandler({ repoDir: "/no/such/path" });
    const res = await handler();
    expect(res.status).toBe(404);
  });

  it("create streams a valid tar of repoDir contents", async () => {
    writeFileSync(join(repoDir, "package.json"), '{"name":"x"}\n');
    mkdirSync(join(repoDir, "src"));
    writeFileSync(join(repoDir, "src", "index.ts"), "export {};\n");

    const handler = makeSnapshotCreateHandler({ repoDir });
    const res = await handler();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // Tar magic at offset 257 of the first 512-byte block: "ustar\0" or "ustar  \0"
    expect(buf.slice(257, 263).toString("ascii")).toMatch(/ustar/);
  });

  it("round-trips a populated workdir create → restore", async () => {
    // Source files in the original repoDir.
    writeFileSync(join(repoDir, "package.json"), '{"name":"vibe"}');
    writeFileSync(join(repoDir, "README.md"), "# Hello\n");
    mkdirSync(join(repoDir, "src"));
    writeFileSync(join(repoDir, "src", "index.ts"), "export const x = 1;\n");
    // Untracked-but-not-ignored file — must survive the round-trip.
    writeFileSync(join(repoDir, ".env.local"), "FOO=bar\n");

    const create = makeSnapshotCreateHandler({ repoDir });
    const tarRes = await create();
    expect(tarRes.status).toBe(200);
    const tarBytes = new Uint8Array(await tarRes.arrayBuffer());
    expect(tarBytes.byteLength).toBeGreaterThan(0);

    // Fresh, empty target dir simulating a cold sandbox.
    const restoreDir = mkdtempSync(join(tmpdir(), "snapshot-restore-"));
    try {
      const restore = makeSnapshotRestoreHandler({ repoDir: restoreDir });
      const req = new Request("http://x/_decopilot_vm/snapshot/restore", {
        method: "POST",
        body: tarBytes,
      });
      const restoreRes = await restore(req);
      expect(restoreRes.status).toBe(200);
      const body = (await restoreRes.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify byte-for-byte file restoration.
      expect(readFileSync(join(restoreDir, "package.json"), "utf8")).toBe(
        '{"name":"vibe"}',
      );
      expect(readFileSync(join(restoreDir, "README.md"), "utf8")).toBe(
        "# Hello\n",
      );
      expect(readFileSync(join(restoreDir, "src/index.ts"), "utf8")).toBe(
        "export const x = 1;\n",
      );
      expect(readFileSync(join(restoreDir, ".env.local"), "utf8")).toBe(
        "FOO=bar\n",
      );
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("create excludes ./tmp from the archive", async () => {
    mkdirSync(join(repoDir, "tmp"));
    writeFileSync(join(repoDir, "tmp", "scratch.txt"), "should not survive");
    writeFileSync(join(repoDir, "kept.txt"), "should survive");

    const tarBytes = new Uint8Array(
      await (await makeSnapshotCreateHandler({ repoDir })()).arrayBuffer(),
    );

    const restoreDir = mkdtempSync(join(tmpdir(), "snapshot-exclude-"));
    try {
      const restoreRes = await makeSnapshotRestoreHandler({
        repoDir: restoreDir,
      })(
        new Request("http://x", {
          method: "POST",
          body: tarBytes,
        }),
      );
      expect(restoreRes.status).toBe(200);

      // kept.txt survives.
      expect(readFileSync(join(restoreDir, "kept.txt"), "utf8")).toBe(
        "should survive",
      );
      // tmp/scratch.txt does not.
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(restoreDir, "tmp", "scratch.txt"))).toBe(false);
    } finally {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("restore returns 400 when request body is missing", async () => {
    const restore = makeSnapshotRestoreHandler({ repoDir });
    // Pass a `Request` whose body is null — synthesize one via Request
    // semantics: GETs always have null bodies; we pass `method: GET` here
    // purely to coerce req.body=null.
    const req = new Request("http://x", { method: "GET" });
    const res = await restore(req);
    expect(res.status).toBe(400);
  });

  it("restore creates repoDir if absent", async () => {
    // Seed a tar in a known-good dir.
    writeFileSync(join(repoDir, "hello.txt"), "hi");
    const tarBytes = new Uint8Array(
      await (await makeSnapshotCreateHandler({ repoDir })()).arrayBuffer(),
    );

    const freshParent = mkdtempSync(join(tmpdir(), "snapshot-mkdir-"));
    const targetDir = join(freshParent, "nested", "subdir", "repo");
    try {
      const res = await makeSnapshotRestoreHandler({ repoDir: targetDir })(
        new Request("http://x", { method: "POST", body: tarBytes }),
      );
      expect(res.status).toBe(200);
      expect(readFileSync(join(targetDir, "hello.txt"), "utf8")).toBe("hi");
    } finally {
      rmSync(freshParent, { recursive: true, force: true });
    }
  });

  it("restore returns 500 on malformed tar input", async () => {
    const restore = makeSnapshotRestoreHandler({ repoDir });
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await restore(
      new Request("http://x", { method: "POST", body: garbage }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; stderr: string };
    expect(body.error).toMatch(/tar restore exited/);
  });
});
