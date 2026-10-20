/**
 * The sandbox content protocol over an in-process stand-in for the daemon's
 * file routes (see content-storage-test-helpers.ts); the daemon e2e runs the
 * same suites over the real Go daemon.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitAll,
  defineSandboxContentSuites,
  fakeDaemon,
  git,
  gitInit,
  rpc,
  sandboxRoute,
  seedSite,
} from "./content-storage-test-helpers";
import {
  createSandboxContentStorage,
  parseScan,
  stripLineNumbers,
} from "./content-storage";

defineSandboxContentSuites(
  "stand-in daemon",
  async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sandbox-content-"));
    return { repoDir, proxyDaemonRequest: fakeDaemon(repoDir) };
  },
  async ({ repoDir }) => rmSync(repoDir, { recursive: true, force: true }),
);

describe("sandbox content storage", () => {
  test("a write that fails half way puts back the files already written", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sandbox-content-"));
    try {
      seedSite(repoDir, { schema: true });
      writeFileSync(join(repoDir, ".deco/blocks/a.json"), '{"v":"a0"}');
      const daemon = fakeDaemon(repoDir, {
        beforeWrite: (path) => {
          if (path.endsWith("/b.json")) throw new Error("disk full");
        },
      });
      const route = sandboxRoute(() => ({
        repoDir,
        proxyDaemonRequest: async (claim, path, init) => {
          try {
            return await daemon(claim, path, init);
          } catch (error) {
            return new Response(JSON.stringify({ error: String(error) }), {
              status: 500,
            });
          }
        },
      }));
      const answer = await rpc(route, "blocks.apply", {
        set: { a: { v: "a1" }, b: { v: "b1" } },
      });
      expect(answer.error?.code).toBe(-32008);
      expect(readFileSync(join(repoDir, ".deco/blocks/a.json"), "utf8")).toBe(
        '{"v":"a0"}',
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("a sandbox it can't reach is Unavailable, never Internal", async () => {
    const route = sandboxRoute(() => ({
      repoDir: "/nowhere",
      proxyDaemonRequest: async () => {
        throw new Error("connection refused");
      },
    }));
    const answer = await rpc(route, "blocks.list");
    expect(answer.error?.code).toBe(-32008);
  });

  test("read answers lose exactly their line numbers", () => {
    expect(stripLineNumbers('1\t{\n2\t\t"a": 1\n3\t}\n4\t')).toBe(
      '{\n\t"a": 1\n}\n',
    );
    expect(stripLineNumbers("1\t")).toBe("");
    expect(stripLineNumbers("1\tx\r\n2\t12\t3")).toBe("x\r\n12\t3");
  });

  test("a listing keeps only block files, each with its own hash", () => {
    const h = (c: string) => c.repeat(40);
    const scan = parseScan(
      `${h("a")} schema.gen.json\n${h("1")} blocks/.hidden.json\n${h("2")} blocks/Home Page.json\n${h("3")} other.json\n@end\n`,
    );
    expect(scan.meta.get("schema.gen.json")).toBe(h("a"));
    expect([...scan.blocks]).toEqual([["Home Page.json", h("2")]]);
    // A listing that lost its end (or anything after a cut) is refused.
    expect(() => parseScan(`${h("2")} blocks/Home.json\n`)).toThrow();
    expect(() => parseScan("")).toThrow();
    expect(() => parseScan(`json\n${h("2")} blocks/Home.json\n@end`)).toThrow();
  });

  test("a listing carries HEAD, its branch, its blocks and the filter-equal files", () => {
    const h = (c: string) => c.repeat(40);
    const scan = parseScan(
      [
        `${h("2")} blocks/Home.json`,
        `@head ${h("c")}`,
        "@ref main",
        `@base ${h("2")} 12 blocks/Home.json`,
        `@base ${h("3")}  blocks/Old.json`,
        `@base ${h("4")} 3 blocks/.hidden.json`,
        "@clean blocks/Home.json",
        "@end",
      ].join("\n"),
    );
    expect(scan.git).toEqual({
      head: h("c"),
      ref: "main",
      base: new Map([
        ["Home.json", { version: h("2"), size: 12 }],
        ["Old.json", { version: h("3") }],
      ]),
      clean: new Set(["Home.json"]),
    });
    expect(parseScan("@head unborn\n@ref\n@end").git).toMatchObject({
      head: "unborn",
      ref: null,
    });
    expect(parseScan("@head none\n@end").git).toBeNull();
    expect(() => parseScan("@head HEAD\n@end")).toThrow();
    expect(() => parseScan("@what x\n@end")).toThrow();
  });

  test("a commit computed from another HEAD is stale, and writes nothing", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sandbox-content-"));
    try {
      gitInit(repoDir);
      seedSite(repoDir, { schema: true });
      writeFileSync(join(repoDir, ".deco/blocks/a.json"), '{"v":"a0"}');
      commitAll(repoDir);
      const storage = createSandboxContentStorage({
        daemon: (path, body) =>
          fakeDaemon(repoDir)("claim", path, {
            method: "POST",
            headers: new Headers(),
            body: JSON.stringify(body),
          }),
        packagePath: null,
      });
      const base = await storage.base();
      expect(base.revision).toBe(git(repoDir, "rev-parse", "HEAD").trim());
      writeFileSync(join(repoDir, ".deco/blocks/a.json"), '{"v":"a1"}');
      commitAll(repoDir, "moved on");
      const result = await storage.commit({
        base: await storage.snapshot(),
        put: { "a.json": '{"v":"a0"}' },
        delete: [],
        expected: {},
        expectedBase: base.revision,
        reason: "discard",
      });
      expect(result).toEqual({ status: "stale" });
      expect(readFileSync(join(repoDir, ".deco/blocks/a.json"), "utf8")).toBe(
        '{"v":"a1"}',
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("outside a git repository, changes are Unavailable and the rest still works", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sandbox-content-"));
    try {
      seedSite(repoDir, { schema: true });
      const route = sandboxRoute(() => ({
        repoDir,
        proxyDaemonRequest: fakeDaemon(repoDir),
      }));
      expect((await rpc(route, "blocks.list")).error).toBeUndefined();
      expect((await rpc(route, "changes.list")).error?.code).toBe(-32008);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("a listing the daemon cut short is an error, never an empty site", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sandbox-content-"));
    try {
      seedSite(repoDir, { schema: true });
      writeFileSync(join(repoDir, ".deco/blocks/a.json"), '{"v":"a0"}');
      const route = sandboxRoute(() => ({
        repoDir,
        proxyDaemonRequest: fakeDaemon(repoDir, { stdoutLimit: 8 }),
      }));
      const listed = await rpc(route, "blocks.list");
      expect(listed.error?.code).toBe(-32008);
      expect(listed.result).toBeUndefined();
      const applied = await rpc(route, "blocks.apply", {
        set: { a: { v: "a1" } },
        ifMatch: { a: null },
      });
      expect(applied.error?.code).toBe(-32008);
      expect(readFileSync(join(repoDir, ".deco/blocks/a.json"), "utf8")).toBe(
        '{"v":"a0"}',
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("a write that lands but then fails is put back too", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sandbox-content-"));
    try {
      seedSite(repoDir, { schema: true });
      writeFileSync(join(repoDir, ".deco/blocks/a.json"), '{"v":"a0"}');
      writeFileSync(join(repoDir, ".deco/blocks/b.json"), '{"v":"b0"}');
      // The write lands, then the call throws (a timeout, a lost connection).
      let failed = false;
      const route = sandboxRoute(() => ({
        repoDir,
        proxyDaemonRequest: fakeDaemon(repoDir, {
          afterWrite: (path) => {
            if (failed || !path.endsWith("/b.json")) return;
            failed = true;
            throw new Error("timed out");
          },
        }),
      }));
      const answer = await rpc(route, "blocks.apply", {
        set: { a: { v: "a1" }, b: { v: "b1" }, c: { v: "c1" } },
      });
      expect(answer.error?.code).toBe(-32008);
      expect(readFileSync(join(repoDir, ".deco/blocks/a.json"), "utf8")).toBe(
        '{"v":"a0"}',
      );
      expect(readFileSync(join(repoDir, ".deco/blocks/b.json"), "utf8")).toBe(
        '{"v":"b0"}',
      );
      expect(existsSync(join(repoDir, ".deco/blocks/c.json"))).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
