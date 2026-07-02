import { describe, expect, it } from "bun:test";
import { buildDepLines, isPackageManifest } from "./dep-metrics";

describe("isPackageManifest", () => {
  it("accepts real package roots (npm/yarn/bun + nested + pnpm)", () => {
    expect(isPackageManifest("react/package.json")).toBe(true);
    expect(isPackageManifest("@scope/pkg/package.json")).toBe(true);
    expect(isPackageManifest("foo/node_modules/bar/package.json")).toBe(true);
    expect(
      isPackageManifest(".pnpm/bar@1.0.0/node_modules/bar/package.json"),
    ).toBe(true);
    expect(
      isPackageManifest(
        ".pnpm/@scope+bar@1.0.0/node_modules/@scope/bar/package.json",
      ),
    ).toBe(true);
  });

  it("rejects fixture/sample package.json shipped inside a package", () => {
    expect(isPackageManifest("foo/test/fixtures/package.json")).toBe(false);
    expect(isPackageManifest(".cache/foo/package.json")).toBe(false);
    expect(isPackageManifest("package.json")).toBe(false);
  });
});

describe("buildDepLines", () => {
  const input = {
    bootId: "boot-1",
    packageManager: "bun" as const,
    repoName: "org/repo",
    branch: "main",
  };
  const dep = (i: number) => ({
    name: `@scope/package-name-${i}`,
    version: `10.${i}.${i}`,
  });

  it("chunks a big install into parseable lines under the 16KB pipeline cap", () => {
    const deps = Array.from({ length: 391 }, (_, i) => dep(i));
    const lines = buildDepLines(deps, input);
    expect(lines.length).toBe(2);
    const seen: string[] = [];
    for (const line of lines) {
      expect(line.length).toBeLessThan(16_000);
      const o = JSON.parse(line);
      expect(o.msg).toBe("sandbox.deps");
      expect(o.chunks).toBe(2);
      expect(o.dependencyCount).toBe(391);
      expect(typeof o.deps).toBe("string");
      seen.push(...JSON.parse(o.deps));
    }
    expect(seen.length).toBe(391);
    expect(new Set(seen).size).toBe(391);
    expect(seen[0]).toBe("@scope/package-name-0@10.0.0");
  });

  it("emits a single countable line for a zero-dep install", () => {
    const lines = buildDepLines([], input);
    expect(lines.length).toBe(1);
    const o = JSON.parse(lines[0]);
    expect(o.dependencyCount).toBe(0);
    expect(JSON.parse(o.deps)).toEqual([]);
  });
});
