import { describe, expect, it } from "bun:test";
import { decideMusl, nativeVariantOrder } from "./resolve-executable";

describe("decideMusl", () => {
  it("is never musl off-linux (no gnu/musl split there)", () => {
    expect(
      decideMusl({
        platform: "darwin",
        glibcVersionRuntime: undefined,
        hasMuslLoader: true,
      }),
    ).toBe(false);
    expect(
      decideMusl({
        platform: "win32",
        glibcVersionRuntime: undefined,
        hasMuslLoader: true,
      }),
    ).toBe(false);
  });

  it("treats a positive glibc version as authoritative glibc", () => {
    expect(
      decideMusl({
        platform: "linux",
        glibcVersionRuntime: "2.35",
        hasMuslLoader: false,
      }),
    ).toBe(false);
    // A stray musl loader must not override a positive glibc signal.
    expect(
      decideMusl({
        platform: "linux",
        glibcVersionRuntime: "2.35",
        hasMuslLoader: true,
      }),
    ).toBe(false);
  });

  it("THE BUG: glibcVersionRuntime undefined on a glibc host (no musl loader) is NOT musl", () => {
    // This is the customer's case. The SDK's own check (glibcVersionRuntime
    // only) would wrongly conclude musl here; the loader probe keeps us correct.
    expect(
      decideMusl({
        platform: "linux",
        glibcVersionRuntime: undefined,
        hasMuslLoader: false,
      }),
    ).toBe(false);
  });

  it("is musl on a real musl host (no glibc version + musl loader present)", () => {
    expect(
      decideMusl({
        platform: "linux",
        glibcVersionRuntime: undefined,
        hasMuslLoader: true,
      }),
    ).toBe(true);
  });

  it("treats an empty-string glibc version as absent", () => {
    expect(
      decideMusl({
        platform: "linux",
        glibcVersionRuntime: "",
        hasMuslLoader: true,
      }),
    ).toBe(true);
    expect(
      decideMusl({
        platform: "linux",
        glibcVersionRuntime: "",
        hasMuslLoader: false,
      }),
    ).toBe(false);
  });
});

describe("nativeVariantOrder", () => {
  it("prefers gnu, falls back to musl, on glibc linux", () => {
    expect(nativeVariantOrder("linux", "x64", false)).toEqual([
      "linux-x64",
      "linux-x64-musl",
    ]);
    expect(nativeVariantOrder("linux", "arm64", false)).toEqual([
      "linux-arm64",
      "linux-arm64-musl",
    ]);
  });

  it("prefers musl, falls back to gnu, on musl linux", () => {
    expect(nativeVariantOrder("linux", "x64", true)).toEqual([
      "linux-x64-musl",
      "linux-x64",
    ]);
  });

  it("uses the single platform variant off-linux", () => {
    expect(nativeVariantOrder("darwin", "arm64", false)).toEqual([
      "darwin-arm64",
    ]);
    expect(nativeVariantOrder("win32", "x64", false)).toEqual(["win32-x64"]);
  });
});
