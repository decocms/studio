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

  // Every emitted line must round-trip and stay under the pipeline's 16KB
  // byte cap; the full dep set must survive across chunks exactly once.
  const assertIntact = (
    lines: string[],
    deps: { name: string; version: string }[],
  ) => {
    const seen: string[] = [];
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThan(16_000);
      const o = JSON.parse(line);
      expect(o.msg).toBe("sandbox.deps");
      expect(o.chunks).toBe(lines.length);
      expect(o.dependencyCount).toBe(deps.length);
      expect(typeof o.deps).toBe("string");
      seen.push(...JSON.parse(o.deps));
    }
    expect(seen.length).toBe(deps.length);
    expect(new Set(seen).size).toBe(deps.length);
    return seen;
  };

  it("chunks a big install into parseable lines under the 16KB pipeline cap", () => {
    const deps = Array.from({ length: 391 }, (_, i) => dep(i));
    const lines = buildDepLines(deps, input);
    expect(lines.length).toBeGreaterThan(1);
    const seen = assertIntact(lines, deps);
    expect(seen[0]).toBe("@scope/package-name-0@10.0.0");
  });

  // The bug this fix closes: count-based chunking (200/line) would emit a
  // ~40KB line here and get it truncated. Byte-based chunking must not.
  it("keeps lines under cap even with pathologically long package names", () => {
    const longName = `@${"o".repeat(100)}/${"p".repeat(100)}`; // ~203 chars
    const deps = Array.from({ length: 200 }, (_, i) => ({
      name: longName,
      version: `1.0.${i}`,
    }));
    const lines = buildDepLines(deps, input);
    expect(lines.length).toBeGreaterThan(2);
    assertIntact(lines, deps);
  });

  it("emits a single countable line for a zero-dep install", () => {
    const lines = buildDepLines([], input);
    expect(lines.length).toBe(1);
    const o = JSON.parse(lines[0]);
    expect(o.dependencyCount).toBe(0);
    expect(JSON.parse(o.deps)).toEqual([]);
  });
});
