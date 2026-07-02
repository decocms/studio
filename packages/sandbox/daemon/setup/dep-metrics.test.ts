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

  // Every emitted line must round-trip and stay SMALL (the pipeline drops
  // large lines — see MAX_LINE_BYTES); the full dep set must survive across
  // chunks exactly once. 700 = MAX_LINE_BYTES (600) + headroom for the last
  // element that fits under the running estimate.
  const assertIntact = (
    lines: string[],
    deps: { name: string; version: string }[],
  ) => {
    const seen: string[] = [];
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThan(700);
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

  it("splits a typical install into many small lines, intact", () => {
    const deps = Array.from({ length: 391 }, (_, i) => dep(i));
    const lines = buildDepLines(deps, input);
    expect(lines.length).toBeGreaterThan(10);
    const seen = assertIntact(lines, deps);
    expect(seen[0]).toBe("@scope/package-name-0@10.0.0");
  });

  // Long names (npm allows up to 214 chars) must still yield only small lines,
  // never an oversized one — the byte budget accounts for them.
  it("keeps lines small even with pathologically long package names", () => {
    const longName = `@${"o".repeat(100)}/${"p".repeat(100)}`; // ~203 chars
    const deps = Array.from({ length: 50 }, (_, i) => ({
      name: longName,
      version: `1.0.${i}`,
    }));
    const lines = buildDepLines(deps, input);
    expect(lines.length).toBeGreaterThan(10);
    assertIntact(lines, deps);
  });

  // deps stored as a string get quotes escaped in the final line (+2 bytes
  // each); many short deps must still yield only small lines.
  it("keeps lines small with thousands of short deps (escaping counted)", () => {
    const deps = Array.from({ length: 4000 }, (_, i) => ({
      name: `p${i}`,
      version: "1.0.0",
    }));
    const lines = buildDepLines(deps, input);
    expect(lines.length).toBeGreaterThan(100);
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
