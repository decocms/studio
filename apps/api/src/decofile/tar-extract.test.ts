// Unit-tier per TESTING.md: no mocks, no DB, no network — hermetic filesystem
// use in per-test mkdtemp dirs plus the real system `tar` binary only.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractBlocksFromTarball,
  TarExtractError,
  tarArgs,
} from "./tar-extract";

describe("tarArgs", () => {
  it("adds --wildcards for GNU tar", () => {
    expect(tarArgs("gnu", "/scratch", "*/.deco/blocks/*.json")).toEqual([
      "-xz",
      "--strip-components=1",
      "-C",
      "/scratch",
      "--wildcards",
      "*/.deco/blocks/*.json",
    ]);
  });

  it("omits --wildcards for BSD tar (globs by default)", () => {
    expect(tarArgs("bsd", "/scratch", "*/.deco/blocks/*.json")).toEqual([
      "-xz",
      "--strip-components=1",
      "-C",
      "/scratch",
      "*/.deco/blocks/*.json",
    ]);
  });
});

describe("extractBlocksFromTarball", () => {
  let fixtureDir: string;
  let scratchDir: string;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "decofile-tar-fixture-"));
    scratchDir = await mkdtemp(join(tmpdir(), "decofile-tar-scratch-"));
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  });

  /** Build a gzipped tarball shaped like a GitHub repo tarball (single
   * top-level `<repo>-<sha>/` dir) with the real `tar` binary. */
  async function buildTarball(
    files: Record<string, string>,
  ): Promise<ReadableStream<Uint8Array>> {
    const top = "repo-abc123";
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(fixtureDir, top, ...rel.split("/"));
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    const out = join(fixtureDir, "archive.tgz");
    const proc = Bun.spawn(["tar", "-czf", out, "-C", fixtureDir, top], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    expect(await proc.exited).toBe(0);
    return Bun.file(out).stream();
  }

  it("extracts only matching block JSONs with the top level stripped", async () => {
    const body = await buildTarball({
      ".deco/blocks/site.json": `{"a":1}`,
      ".deco/blocks/page.json": `{"b":2}`,
      ".deco/blocks/notes.md": "not json",
      "src/other.json": `{"outside":true}`,
      "readme.md": "hi",
    });

    const files = await extractBlocksFromTarball(
      body,
      scratchDir,
      ".deco/blocks",
    );

    expect(files.map((f) => f.path)).toEqual([
      ".deco/blocks/page.json",
      ".deco/blocks/site.json",
    ]);
    for (const file of files) {
      expect(file.diskPath.startsWith(scratchDir)).toBe(true);
      expect(await Bun.file(file.diskPath).exists()).toBe(true);
    }
    // Contents are on disk (not returned) and intact.
    const page = files.find((f) => f.path === ".deco/blocks/page.json");
    expect(await Bun.file((page as { diskPath: string }).diskPath).text()).toBe(
      `{"b":2}`,
    );
  });

  it("throws a typed error on a corrupted stream", async () => {
    const garbage = new Uint8Array(4096);
    crypto.getRandomValues(garbage);
    const body = new Response(garbage).body as ReadableStream<Uint8Array>;

    await expect(
      extractBlocksFromTarball(body, scratchDir, ".deco/blocks"),
    ).rejects.toBeInstanceOf(TarExtractError);
  });

  it("throws a typed error when nothing matches", async () => {
    const body = await buildTarball({ "readme.md": "no blocks here" });

    await expect(
      extractBlocksFromTarball(body, scratchDir, ".deco/blocks"),
    ).rejects.toBeInstanceOf(TarExtractError);
  });

  it("rejects traversal in the blocks path prefix", async () => {
    const body = new Response(new Uint8Array(0))
      .body as ReadableStream<Uint8Array>;
    await expect(
      extractBlocksFromTarball(body, scratchDir, "../escape"),
    ).rejects.toBeInstanceOf(TarExtractError);
  });
});
