import { describe, expect, it } from "bun:test";
import { isPackageManifest } from "./dep-metrics";

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
