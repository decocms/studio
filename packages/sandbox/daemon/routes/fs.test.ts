import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  makeReadHandler,
  makeWriteHandler,
  makeUnlinkHandler,
  makeMkdirHandler,
  makeRenameHandler,
  makeEditHandler,
  makeGrepHandler,
  makeGlobHandler,
  generateDecofileFromBlocks,
  generateDecofileFromBlocksDeduped,
  collectEmptyDirectories,
  pathSegmentDepth,
  registerGlobAncestorDirectories,
  GLOB_RESULT_LIMIT,
  GLOB_MAX_RESULT_LIMIT,
  resolveGlobResultLimit,
  GREP_RESULT_LIMIT,
  GREP_MAX_RESULT_LIMIT,
  resolveGrepResultLimit,
  toRepoRelativePath,
} from "./fs";
import { invalidDecofileBlockJson } from "../decofile-json";

const hasRg = spawnSync("which", ["rg"]).status === 0;

function post(path: string, obj: unknown): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    body: JSON.stringify(obj),
    headers: { "Content-Type": "application/json" },
  });
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
    const res = await h(post("/_sandbox/read", { path: "a.txt" }));
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

  it("read: defaults to 2000 lines but full returns the entire file", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`);
    writeFileSync(join(appRoot, "big.txt"), lines.join("\n"));
    const h = makeReadHandler({ appRoot, repoDir: appRoot });

    const truncated = await h(post("/_sandbox/read", { path: "big.txt" }));
    const truncatedBody = (await truncated.json()) as {
      content: string;
      lineCount: number;
    };
    expect(truncatedBody.lineCount).toBe(2500);
    expect(truncatedBody.content).toContain("1\tline-1");
    expect(truncatedBody.content).toContain("2000\tline-2000");
    expect(truncatedBody.content).not.toContain("2500\tline-2500");

    const full = await h(
      post("/_sandbox/read", { path: "big.txt", full: true }),
    );
    const fullBody = (await full.json()) as {
      content: string;
      lineCount: number;
    };
    expect(fullBody.lineCount).toBe(2500);
    expect(fullBody.content).toContain("1\tline-1");
    expect(fullBody.content).toContain("2500\tline-2500");
  });

  it("read: returns base64 + mediaType for jpeg", async () => {
    // Minimal JPEG: SOI + EOI markers, enough to pass the magic-byte sniff.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    writeFileSync(join(appRoot, "img.jpg"), jpeg);
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/read", { path: "img.jpg" }));
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
    const res = await h(post("/_sandbox/read", { path: "img.png" }));
    const body = (await res.json()) as { kind: string; mediaType: string };
    expect(body.kind).toBe("image");
    expect(body.mediaType).toBe("image/png");
  });

  it("read: rejects non-image binary files", async () => {
    writeFileSync(join(appRoot, "bin"), Buffer.from([0, 1, 2, 3]));
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/read", { path: "bin" }));
    expect(res.status).toBe(400);
  });

  it("read: rejects relative path escape", async () => {
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/read", { path: "../etc/passwd" }));
    expect(res.status).toBe(400);
  });

  it("read: accepts absolute paths", async () => {
    writeFileSync(join(appRoot, "abs.txt"), "hello");
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/read", { path: join(appRoot, "abs.txt") }),
    );
    const body = (await res.json()) as { kind: string; content: string };
    expect(body.kind).toBe("text");
    expect(body.content).toContain("hello");
  });

  it("write: creates file and returns byte count", async () => {
    const h = makeWriteHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/write", { path: "new.txt", content: "hello" }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(appRoot, "new.txt"), "utf-8")).toBe("hello");
  });

  it("unlink: deletes a .deco/blocks json file", async () => {
    const blockDir = join(appRoot, ".deco", "blocks");
    mkdirSync(blockDir, { recursive: true });
    const blockPath = join(blockDir, "Header.json");
    writeFileSync(blockPath, "{}");
    const h = makeUnlinkHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/unlink", { path: ".deco/blocks/Header.json" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; existed: boolean };
    expect(body.ok).toBe(true);
    expect(body.existed).toBe(true);
    expect(() => readFileSync(blockPath)).toThrow();
  });

  it("unlink: is idempotent when the file is missing", async () => {
    const h = makeUnlinkHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/unlink", { path: ".deco/blocks/missing.json" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; existed: boolean };
    expect(body.existed).toBe(false);
  });

  it("unlink: deletes any file under the workspace root", async () => {
    writeFileSync(join(appRoot, "secret.txt"), "x");
    const h = makeUnlinkHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/unlink", { path: "secret.txt" }));
    expect(res.status).toBe(200);
    expect(() => readFileSync(join(appRoot, "secret.txt"))).toThrow();
  });

  it("unlink: refuses directories without recursive", async () => {
    const blockDir = join(appRoot, ".deco", "blocks");
    mkdirSync(blockDir, { recursive: true });
    const h = makeUnlinkHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/unlink", { path: ".deco/blocks" }));
    expect(res.status).toBe(400);
  });

  it("unlink: deletes directories when recursive is true", async () => {
    const dir = join(appRoot, "nested", "dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), "x");
    const h = makeUnlinkHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/unlink", { path: "nested", recursive: true }),
    );
    expect(res.status).toBe(200);
    expect(() => readFileSync(join(dir, "a.txt"))).toThrow();
  });

  it("mkdir: creates a directory", async () => {
    const h = makeMkdirHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/mkdir", { path: "new-dir/nested" }));
    expect(res.status).toBe(200);
    expect(existsSync(join(appRoot, "new-dir", "nested"))).toBe(true);
  });

  it("rename: moves a file", async () => {
    writeFileSync(join(appRoot, "old.txt"), "hello");
    const h = makeRenameHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/rename", { from: "old.txt", to: "new.txt" }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(appRoot, "new.txt"), "utf-8")).toBe("hello");
    expect(() => readFileSync(join(appRoot, "old.txt"))).toThrow();
  });

  it("edit: rejects when old_string doesn't match", async () => {
    writeFileSync(join(appRoot, "e.txt"), "abc");
    const h = makeEditHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/edit", {
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
      post("/_sandbox/edit", {
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
      post("/_sandbox/edit", {
        path: "e.txt",
        old_string: "a",
        new_string: "b",
        replace_all: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(appRoot, "e.txt"), "utf-8")).toBe("b b b");
  });

  describe("invalidDecofileBlockJson (scope)", () => {
    it("flags malformed JSON in a .deco/blocks file", () => {
      expect(
        invalidDecofileBlockJson(".deco/blocks/pages-home.json", "{ bad "),
      ).toContain("invalid JSON");
    });
    it("passes well-formed JSON in a .deco/blocks file", () => {
      expect(
        invalidDecofileBlockJson(".deco/blocks/pages-home.json", '{"a":1}'),
      ).toBeNull();
    });
    it("matches nested and backslash-separated block paths", () => {
      expect(
        invalidDecofileBlockJson("repo/.deco/blocks/nested/x.json", "{"),
      ).toContain("invalid JSON");
      expect(invalidDecofileBlockJson(".deco\\blocks\\x.json", "{")).toContain(
        "invalid JSON",
      );
    });
    it("matches case-insensitively (.JSON on case-insensitive filesystems)", () => {
      expect(
        invalidDecofileBlockJson(".deco/blocks/pages-home.JSON", "{ bad"),
      ).toContain("invalid JSON");
    });
    it("ignores files outside .deco/blocks, JSONC configs, and .gen.json artifacts", () => {
      // out of scope → never parsed, so invalid content is allowed through
      expect(invalidDecofileBlockJson("tsconfig.json", "{ // c\n}")).toBeNull();
      expect(invalidDecofileBlockJson("src/data.json", "{ bad")).toBeNull();
      expect(
        invalidDecofileBlockJson(".deco/blocks.gen.json", "{ bad"),
      ).toBeNull();
      expect(
        invalidDecofileBlockJson(".deco/meta.gen.json", "{ bad"),
      ).toBeNull();
      expect(
        invalidDecofileBlockJson(".deco/blocks/readme.md", "not json"),
      ).toBeNull();
    });
  });

  it("write: rejects invalid JSON for a .deco/blocks file and does not create it", async () => {
    const h = makeWriteHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/write", {
        path: ".deco/blocks/pages-home.json",
        // dangling key inside an array + unbalanced brace — the exact corruption shape
        content: '{ "benefits": [ { "label": "x" }, "rule": { "a": 1 } } ]',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid JSON");
    expect(existsSync(join(appRoot, ".deco/blocks/pages-home.json"))).toBe(
      false,
    );
  });

  it("write: accepts valid JSON for a .deco/blocks file", async () => {
    const h = makeWriteHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/write", {
        path: ".deco/blocks/pages-home.json",
        content: '{\n  "__resolveType": "site/pages/Home.tsx"\n}',
      }),
    );
    expect(res.status).toBe(200);
    expect(existsSync(join(appRoot, ".deco/blocks/pages-home.json"))).toBe(
      true,
    );
  });

  it("write: does not validate JSON outside .deco/blocks (JSONC configs, plain files)", async () => {
    const h = makeWriteHandler({ appRoot, repoDir: appRoot });
    // tsconfig.json is JSONC (comments) and must not be gated
    const res = await h(
      post("/_sandbox/write", {
        path: "tsconfig.json",
        content: "{\n  // a comment\n  }",
      }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(appRoot, "tsconfig.json"), "utf-8")).toContain(
      "// a comment",
    );
  });

  it("edit: rejects an edit that would leave a .deco/blocks file invalid and leaves it intact", async () => {
    const blockDir = join(appRoot, ".deco", "blocks");
    mkdirSync(blockDir, { recursive: true });
    const rel = ".deco/blocks/pages-home.json";
    const valid = JSON.stringify(
      {
        variants: [
          {
            value: { __resolveType: "Benefits" },
            rule: { __resolveType: "never" },
          },
        ],
      },
      null,
      2,
    );
    writeFileSync(join(appRoot, rel), valid);
    const h = makeEditHandler({ appRoot, repoDir: appRoot });
    // unwrap the variant wrapper but leave the `rule` sibling dangling — invalid
    const res = await h(
      post("/_sandbox/edit", {
        path: rel,
        old_string: '"variants": [\n    {\n      "value": {',
        new_string: '"section": {',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid JSON");
    // file must be untouched — the original, still-valid content
    expect(readFileSync(join(appRoot, rel), "utf-8")).toBe(valid);
  });

  it("edit: allows a valid edit to a .deco/blocks file", async () => {
    const blockDir = join(appRoot, ".deco", "blocks");
    mkdirSync(blockDir, { recursive: true });
    const rel = ".deco/blocks/pages-home.json";
    writeFileSync(join(appRoot, rel), '{\n  "title": "old"\n}');
    const h = makeEditHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/edit", {
        path: rel,
        old_string: '"old"',
        new_string: '"new"',
      }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(appRoot, rel), "utf-8")).toContain('"new"');
  });

  (hasRg ? it : it.skip)("grep: returns matching content lines", async () => {
    writeFileSync(join(appRoot, "needle.txt"), "hello world\n");
    const h = makeGrepHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/grep", {
        pattern: "hello",
        output_mode: "content",
      }),
    );
    const body = (await res.json()) as { results: string };
    expect(body.results).toContain("hello world");
  });

  (hasRg ? it : it.skip)(
    "grep: content rows use repo-relative paths",
    async () => {
      mkdirSync(join(appRoot, "src"), { recursive: true });
      writeFileSync(join(appRoot, "src/needle.txt"), "hello world\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post("/_sandbox/grep", {
          pattern: "hello",
          output_mode: "content",
        }),
      );
      const body = (await res.json()) as { results: string };
      // Repo-relative (no absolute appRoot prefix), so the UI/agents can map
      // the hit straight onto glob paths.
      expect(body.results).toBe("src/needle.txt:1:hello world");
    },
  );

  (hasRg ? it : it.skip)(
    "grep: files mode uses repo-relative paths",
    async () => {
      mkdirSync(join(appRoot, "src"), { recursive: true });
      writeFileSync(join(appRoot, "src/needle.txt"), "hello world\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post("/_sandbox/grep", { pattern: "hello", output_mode: "files" }),
      );
      const body = (await res.json()) as { results: string };
      expect(body.results).toBe("src/needle.txt");
    },
  );

  (hasRg ? it : it.skip)(
    "grep: fixed_strings matches the pattern literally",
    async () => {
      writeFileSync(join(appRoot, "dots.txt"), "a.b\naxb\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post("/_sandbox/grep", {
          pattern: "a.b",
          output_mode: "content",
          fixed_strings: true,
        }),
      );
      const body = (await res.json()) as { results: string };
      // Without -F the regexp "a.b" would also match "axb"; with it, only the
      // literal "a.b" line matches.
      expect(body.results).toBe("dots.txt:1:a.b");
    },
  );

  (hasRg ? it : it.skip)(
    "grep: content rows stay repoDir-relative (not searchPath-relative) when a subdir path is searched",
    async () => {
      mkdirSync(join(appRoot, "src"), { recursive: true });
      writeFileSync(join(appRoot, "src/needle.txt"), "hello world\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post("/_sandbox/grep", {
          pattern: "hello",
          output_mode: "content",
          path: "src",
        }),
      );
      const body = (await res.json()) as { results: string };
      // Relative to repoDir (the workspace root), not the narrower searchPath
      // — so the "src/" prefix is kept and the row maps onto the same paths
      // glob returns.
      expect(body.results).toBe("src/needle.txt:1:hello world");
    },
  );

  (hasRg ? it : it.skip)(
    "grep: context rows (-C) are relativized despite their '-' separator",
    async () => {
      writeFileSync(join(appRoot, "ctx.txt"), "before\nhello world\nafter\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post("/_sandbox/grep", {
          pattern: "hello",
          output_mode: "content",
          context: 1,
        }),
      );
      const body = (await res.json()) as { results: string };
      // rg emits context rows as `path-line-text` (vs `path:line:text` for the
      // match itself) — every row's path must still be stripped to
      // repo-relative, not just the ":"-delimited match row.
      for (const row of body.results.split("\n")) {
        if (row === "--") continue;
        expect(row.startsWith(appRoot)).toBe(false);
        expect(row.startsWith("ctx.txt")).toBe(true);
      }
    },
  );

  (hasRg ? it : it.skip)(
    "grep: a colon in the filename doesn't defeat relativization",
    async () => {
      writeFileSync(join(appRoot, "foo:bar.txt"), "hello world\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post("/_sandbox/grep", { pattern: "hello", output_mode: "content" }),
      );
      const body = (await res.json()) as { results: string };
      expect(body.results).toBe("foo:bar.txt:1:hello world");
    },
  );

  (hasRg ? it : it.skip)(
    "grep: content search covers .deco and gitignored files but skips node_modules",
    async () => {
      // .deco is a hidden dir (skipped by rg's default dotfile rule) and is
      // often gitignored — the filename glob still surfaces it, so content
      // search must too, or the two searches disagree.
      mkdirSync(join(appRoot, ".deco/blocks"), { recursive: true });
      writeFileSync(
        join(appRoot, ".deco/blocks/pages-home.json"),
        '{"matcher":"needle"}\n',
      );
      writeFileSync(join(appRoot, ".gitignore"), ".deco/\nignored.txt\n");
      writeFileSync(join(appRoot, "ignored.txt"), "needle\n");
      // node_modules is pure noise the glob walk excludes — grep must keep
      // excluding it even with --hidden/--no-ignore on.
      mkdirSync(join(appRoot, "node_modules/pkg"), { recursive: true });
      writeFileSync(join(appRoot, "node_modules/pkg/index.js"), "needle\n");
      const h = makeGrepHandler({ appRoot, repoDir: appRoot });
      const res = await h(
        post("/_sandbox/grep", { pattern: "needle", output_mode: "files" }),
      );
      const body = (await res.json()) as { results: string };
      const files = body.results.split("\n").filter(Boolean).sort();
      expect(files).toContain(".deco/blocks/pages-home.json");
      expect(files).toContain("ignored.txt");
      expect(files).not.toContain("node_modules/pkg/index.js");
    },
  );

  (hasRg ? it : it.skip)("glob: returns matching file names", async () => {
    writeFileSync(join(appRoot, "x.txt"), "");
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/glob", { pattern: "*.txt" }));
    const body = (await res.json()) as {
      files: string[];
      directories?: string[];
    };
    expect(body.files).toContain("x.txt");
    expect(body.directories ?? []).toEqual([]);
  });

  it("glob: includes dot-directories such as .deco", async () => {
    mkdirSync(join(appRoot, ".deco/blocks"), { recursive: true });
    writeFileSync(join(appRoot, ".deco/blocks/foo.json"), "{}");
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/glob", { pattern: "**/*" }));
    const body = (await res.json()) as {
      files: string[];
      directories?: string[];
    };
    expect(body.files).toContain(".deco/blocks/foo.json");
  });

  it("glob: shows dotfiles but excludes GLOB_EXCLUDE_DIRS", async () => {
    writeFileSync(join(appRoot, ".env"), "SECRET=1");
    mkdirSync(join(appRoot, ".deco/blocks"), { recursive: true });
    writeFileSync(join(appRoot, ".deco/blocks/foo.json"), "{}");
    mkdirSync(join(appRoot, ".git"), { recursive: true });
    writeFileSync(join(appRoot, ".git/config"), "");
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/glob", { pattern: "**/*" }));
    const body = (await res.json()) as { files: string[] };
    expect(body.files).toContain(".env");
    expect(body.files).toContain(".deco/blocks/foo.json");
    expect(body.files).not.toContain(".git/config");
  });

  it("glob: includes empty directories without placeholder files", async () => {
    mkdirSync(join(appRoot, "tavano-folder"), { recursive: true });
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/glob", { pattern: "**/*" }));
    const body = (await res.json()) as {
      files: string[];
      directories: string[];
    };
    expect(body.directories).toContain("tavano-folder");
  });

  it("glob: includes .gitkeep folder markers in files", async () => {
    mkdirSync(join(appRoot, "empty-dir"), { recursive: true });
    writeFileSync(join(appRoot, "empty-dir", ".gitkeep"), "");
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/glob", { pattern: "**/*" }));
    const body = (await res.json()) as { files: string[] };
    expect(body.files).toContain("empty-dir/.gitkeep");
  });

  it("glob: maxDepth skips deeper files but registers ancestor directories", async () => {
    mkdirSync(join(appRoot, "a/b/c/d"), { recursive: true });
    writeFileSync(join(appRoot, "a/b/c/d/deep.txt"), "x");
    writeFileSync(join(appRoot, "a/b/shallow.txt"), "y");
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/glob", { pattern: "**/*", maxDepth: 3 }),
    );
    const body = (await res.json()) as {
      files: string[];
      directories: string[];
    };
    expect(body.files).toContain("a/b/shallow.txt");
    expect(body.files).not.toContain("a/b/c/d/deep.txt");
    expect(body.directories).toContain("a/b/c");
  });

  it("glob: explicit limit truncates results", async () => {
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(appRoot, `file-${i}.txt`), "");
    }
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/glob", {
        pattern: "*.txt",
        limit: 5,
      }),
    );
    const body = (await res.json()) as {
      files: string[];
      truncated?: boolean;
    };
    expect(body.files.length).toBe(5);
    expect(body.truncated).toBe(true);
  });

  it("resolveGlobResultLimit caps at GLOB_MAX_RESULT_LIMIT", () => {
    expect(resolveGlobResultLimit(undefined)).toBe(GLOB_RESULT_LIMIT);
    expect(resolveGlobResultLimit(GLOB_MAX_RESULT_LIMIT + 999)).toBe(
      GLOB_MAX_RESULT_LIMIT,
    );
  });

  it("resolveGrepResultLimit caps at GREP_MAX_RESULT_LIMIT", () => {
    expect(resolveGrepResultLimit(undefined)).toBe(GREP_RESULT_LIMIT);
    expect(resolveGrepResultLimit(GREP_MAX_RESULT_LIMIT + 999)).toBe(
      GREP_MAX_RESULT_LIMIT,
    );
    expect(resolveGrepResultLimit(0)).toBe(GREP_RESULT_LIMIT);
    expect(resolveGrepResultLimit(-5)).toBe(GREP_RESULT_LIMIT);
    expect(resolveGrepResultLimit(50)).toBe(50);
  });

  it("glob: default limit remains GLOB_RESULT_LIMIT for agents", async () => {
    for (let i = 0; i < GLOB_RESULT_LIMIT + 5; i++) {
      writeFileSync(join(appRoot, `agent-${i}.txt`), "");
    }
    const h = makeGlobHandler({ appRoot, repoDir: appRoot });
    const res = await h(post("/_sandbox/glob", { pattern: "agent-*.txt" }));
    const body = (await res.json()) as {
      files: string[];
      truncated?: boolean;
    };
    expect(body.files.length).toBe(GLOB_RESULT_LIMIT);
    expect(body.truncated).toBe(true);
  });

  it("pathSegmentDepth counts path segments", () => {
    expect(pathSegmentDepth("a/b/c.ts")).toBe(3);
    expect(pathSegmentDepth("README.md")).toBe(1);
  });

  it("registerGlobAncestorDirectories adds ancestors up to maxDepth", () => {
    const dirs = new Set<string>();
    registerGlobAncestorDirectories("a/b/c/d.ts", 3, dirs, true);
    expect([...dirs].sort()).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("registerGlobAncestorDirectories handles directory paths", () => {
    const dirs = new Set<string>();
    registerGlobAncestorDirectories("a/b/c/d", 3, dirs, false);
    expect([...dirs].sort()).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("toRepoRelativePath: strips the repoDir prefix on POSIX-style paths", () => {
    expect(toRepoRelativePath("/repo/needle.txt", "/repo", "/repo")).toBe(
      "needle.txt",
    );
  });

  it("toRepoRelativePath: strips a Windows-style backslash repoDir prefix", () => {
    // Simulates what path.join/path.relative produce on win32, regardless
    // of the host OS actually running this test — this is the exact shape
    // that broke the naive `${repoDir}/`-prefixed startsWith check (mixed
    // separators never matched, so the full absolute path leaked into the
    // wire response instead of a repo-relative one).
    expect(
      toRepoRelativePath(
        "C:\\Users\\runner\\repo\\needle.txt",
        "C:\\Users\\runner\\repo",
        "C:\\Users\\runner\\repo",
      ),
    ).toBe("needle.txt");
  });

  it("toRepoRelativePath: falls back to the searchPath prefix when abs is outside repoDir", () => {
    expect(
      toRepoRelativePath(
        "C:\\Users\\runner\\app\\dev\\index.ts",
        "C:\\Users\\runner\\app\\dev",
        "C:\\Users\\runner\\app\\repo",
      ),
    ).toBe("index.ts");
  });

  it("toRepoRelativePath: normalizes nested Windows subdirectories to forward slashes", () => {
    expect(
      toRepoRelativePath(
        "C:\\Users\\runner\\repo\\.deco\\tools\\ARCHIVE_EMAIL.json",
        "C:\\Users\\runner\\repo",
        "C:\\Users\\runner\\repo",
      ),
    ).toBe(".deco/tools/ARCHIVE_EMAIL.json");
  });

  it("collectEmptyDirectories ignores parents of nested directories", () => {
    expect(collectEmptyDirectories([], ["src", "src/components"])).toEqual([
      "src/components",
    ]);
  });

  it("unlink: refuses recursive delete of repository root", async () => {
    const h = makeUnlinkHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/unlink", { path: ".", recursive: true }),
    );
    expect(res.status).toBe(400);
  });

  it("unlink: refuses deleting .git", async () => {
    mkdirSync(join(appRoot, ".git"), { recursive: true });
    writeFileSync(join(appRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    const h = makeUnlinkHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/unlink", { path: ".git/HEAD", recursive: false }),
    );
    expect(res.status).toBe(400);
  });

  it("rename: rejects destination that already exists", async () => {
    writeFileSync(join(appRoot, "old.txt"), "hello");
    writeFileSync(join(appRoot, "new.txt"), "taken");
    const h = makeRenameHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/rename", { from: "old.txt", to: "new.txt" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("decofile fallback (blocks.gen.json generation)", () => {
  let appRoot = "";
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "decofile-gen-"));
  });
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true });
  });

  const writeBlock = (stem: string, value: unknown) => {
    const dir = join(appRoot, ".deco", "blocks");
    mkdirSync(dir, { recursive: true });
    // Pretty-printed, like the runtime writes them.
    writeFileSync(join(dir, `${stem}.json`), JSON.stringify(value, null, 2));
  };

  it("generateDecofileFromBlocks: merges files keyed by decoded stem", async () => {
    // %20 in the stem decodes to a space in the block id.
    writeBlock("Banner%20Home", { banners: [{ alt: "a" }] });
    writeBlock("pages%2FHome", { __resolveType: "page" });
    const merged = await generateDecofileFromBlocks(
      join(appRoot, ".deco", "blocks"),
    );
    expect(merged).not.toBeNull();
    const parsed = JSON.parse(merged!) as Record<string, unknown>;
    expect(parsed).toEqual({
      "Banner Home": { banners: [{ alt: "a" }] },
      "pages/Home": { __resolveType: "page" },
    });
  });

  it("generateDecofileFromBlocks: returns null with no blocks dir", async () => {
    expect(await generateDecofileFromBlocks(join(appRoot, "nope"))).toBeNull();
  });

  it("generateDecofileFromBlocks: returns null for an empty blocks dir", async () => {
    mkdirSync(join(appRoot, ".deco", "blocks"), { recursive: true });
    expect(
      await generateDecofileFromBlocks(join(appRoot, ".deco", "blocks")),
    ).toBeNull();
  });

  it("generateDecofileFromBlocks: ignores non-.json and empty files", async () => {
    writeBlock("Real", { ok: true });
    const dir = join(appRoot, ".deco", "blocks");
    writeFileSync(join(dir, "README.md"), "not a block");
    writeFileSync(join(dir, "Empty.json"), "   ");
    const merged = await generateDecofileFromBlocks(dir);
    expect(JSON.parse(merged!)).toEqual({ Real: { ok: true } });
  });

  it("read: generates blocks.gen.json on the fly when it is absent", async () => {
    writeBlock("Section%20One", { title: "one" });
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/read", { path: ".deco/blocks.gen.json", full: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; content: string };
    expect(body.kind).toBe("text");
    // Un-numbered: the client's stripLineNumbers (which strips `^\d+\t`) is a
    // no-op on pretty JSON, so the raw content JSON.parses directly.
    expect(JSON.parse(body.content)).toEqual({
      "Section One": { title: "one" },
    });
  });

  it("read: prefers the committed blocks.gen.json when it exists", async () => {
    writeBlock("Section%20One", { title: "from-blocks-dir" });
    // A committed artifact that intentionally disagrees with the sources.
    writeFileSync(
      join(appRoot, ".deco", "blocks.gen.json"),
      JSON.stringify({ "Section One": { title: "committed" } }),
    );
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/read", { path: ".deco/blocks.gen.json", full: true }),
    );
    const body = (await res.json()) as { content: string };
    expect(JSON.parse(stripLineNumbers(body.content))).toEqual({
      "Section One": { title: "committed" },
    });
  });

  it("read: still 400s for blocks.gen.json when there is no blocks dir", async () => {
    mkdirSync(join(appRoot, ".deco"), { recursive: true });
    const h = makeReadHandler({ appRoot, repoDir: appRoot });
    const res = await h(
      post("/_sandbox/read", { path: ".deco/blocks.gen.json", full: true }),
    );
    expect(res.status).toBe(400);
  });

  it("deduped: concurrent rebuilds share one in-flight promise, then reset", async () => {
    writeBlock("Section%20One", { title: "one" });
    const dir = join(appRoot, ".deco", "blocks");
    // Concurrent callers coalesce onto the same build (no per-call re-merge).
    const p1 = generateDecofileFromBlocksDeduped(dir);
    const p2 = generateDecofileFromBlocksDeduped(dir);
    expect(p1).toBe(p2);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(JSON.parse(a!)).toEqual({ "Section One": { title: "one" } });
    // After settling it's a coalescer, not a cache: a fresh call rebuilds.
    const p3 = generateDecofileFromBlocksDeduped(dir);
    expect(p3).not.toBe(p1);
    expect(JSON.parse((await p3)!)).toEqual({
      "Section One": { title: "one" },
    });
  });
});

/** Mirrors the frontend's stripLineNumbers so the test asserts the same contract. */
function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\d+\t/, ""))
    .join("\n");
}
