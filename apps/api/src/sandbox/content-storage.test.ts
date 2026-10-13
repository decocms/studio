/**
 * The sandbox content protocol over an in-process stand-in for the daemon's
 * file routes (see content-storage-test-helpers.ts); the daemon e2e runs the
 * same suites over the real Go daemon.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineSandboxContentSuites,
  fakeDaemon,
  rpc,
  sandboxRoute,
  seedSite,
} from "./content-storage-test-helpers";
import { parseScan, stripLineNumbers } from "./content-storage";

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

  test("a listing keeps only block files, paired with their hashes", () => {
    expect(parseScan("@none\n")).toBeNull();
    const scan = parseScan(
      "@meta schema.gen.json aaa\n@files\n.hidden.json\nHome.json\n@hashes\nh1\nh2\n",
    );
    expect(scan?.meta.get("schema.gen.json")).toBe("aaa");
    expect([...(scan?.blocks ?? [])]).toEqual([["Home.json", "h2"]]);
    expect(() => parseScan("@files\na.json\n@hashes\n")).toThrow();
  });
});
