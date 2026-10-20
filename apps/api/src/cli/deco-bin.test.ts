/**
 * The published `decocms` package and its Docker image must start Studio's
 * own CLI. `@decocms/blocks` also declares a `deco` bin: as a runtime
 * dependency, `bun add decocms` linked whichever `deco` won into
 * `node_modules/.bin`, and the image started the Blocks CLI
 * (`unknown command "--no-tui"`). The server bundle inlines what it needs, so
 * no runtime dependency may declare a `deco` bin, and the image starts Studio
 * by path, never through the `deco` bin name. `scripts/smoke-tarball.ts`
 * checks the same on the packed tarball.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(import.meta.dir, "..", "..");

interface PackageJson {
  name: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackage(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function binNames(pkg: PackageJson): string[] {
  if (!pkg.bin) return [];
  if (typeof pkg.bin === "string") return [pkg.name.split("/").pop()!];
  return Object.keys(pkg.bin);
}

const api = readPackage(API_ROOT);
const runtimeDeps = {
  ...api.dependencies,
  ...api.optionalDependencies,
};

describe("the deco bin", () => {
  test("is Studio's CLI", () => {
    expect(api.name).toBe("decocms");
    expect(api.bin).toEqual({ deco: "./dist/server/cli.js" });
  });

  test("@decocms/blocks is bundled, never a runtime dependency", () => {
    expect(Object.keys(runtimeDeps)).not.toContain("@decocms/blocks");
  });

  test("no installed runtime dependency declares another deco bin", () => {
    const clashes = Object.keys(runtimeDeps).filter((name) => {
      const dir = join(API_ROOT, "node_modules", name);
      // Optional platform packages may be missing on this machine.
      if (!existsSync(join(dir, "package.json"))) return false;
      return binNames(readPackage(dir)).includes("deco");
    });
    expect(clashes).toEqual([]);
  });

  test("the Docker image starts Studio by path, not through the deco bin", () => {
    const dockerfile = readFileSync(join(API_ROOT, "Dockerfile"), "utf8");
    const cmd = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("CMD "))
      .pop();
    expect(cmd).toBeDefined();
    const argv = JSON.parse(cmd!.slice("CMD ".length)) as string[];
    expect(argv.slice(0, 2)).toEqual(["bun", "run"]);
    // `bun add` of the tarball installs it at node_modules/decocms.
    expect(argv[2]).toStartWith(`node_modules/${api.name}/dist/server/`);
    expect(argv).not.toContain("deco");
  });
});
