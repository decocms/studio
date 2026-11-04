import { describe, expect, it } from "bun:test";
import { blockVersion } from "./block-version";
import {
  isRevisionId,
  newRevisionId,
  revisionTimeAfter,
  revisionTimeMs,
} from "./revision-id";

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));

describe("newRevisionId (contract §1.2 vectors)", () => {
  it("reproduces the design's example", () => {
    expect(newRevisionId(0x0193a1f26800, bytes("0c3e9d2a4b8e1f0c7a55"))).toBe(
      "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55",
    );
  });

  it("sets the version and variant bits and sorts newest first", () => {
    const older = newRevisionId(
      Date.parse("2026-11-03T12:00:00.000Z"),
      new Uint8Array(10),
    );
    const newer = newRevisionId(
      Date.parse("2026-11-03T12:00:00.001Z"),
      new Uint8Array(10).fill(0xff),
    );
    expect(older).toBe("fe5e5eb831ff-01a1a147-ce00-7000-8000-000000000000");
    expect(newer).toBe("fe5e5eb831fe-01a1a147-ce01-7fff-bfff-ffffffffffff");
    expect([older, newer].sort()).toEqual([newer, older]);
  });

  it("validates ids with the shared regex", () => {
    expect(isRevisionId(newRevisionId())).toBe(true);
    expect(isRevisionId("a".repeat(40))).toBe(false);
    expect(
      isRevisionId("fe6c5e0d97ff-0193a1f2-6800-4c3e-9d2a-4b8e1f0c7a55"),
    ).toBe(false);
  });
});

describe("blockVersion (contract §1.3 vectors)", () => {
  it.each([
    [{}, "RBNvo1WzZ4oRRq0W9-hkng"],
    [{ b: 1, a: [true, null, "x"] }, "VKZUFa03AiiFGh2ksxtv1A"],
    [
      {
        __resolveType: "site/sections/Hero.tsx",
        title: "Olá — ünïcode 😀",
        n: -0,
        f: 1.5e-7,
        big: 1e21,
        int: 10,
      },
      "cvNhsZmxtnrgaCwRg73Kxw",
    ],
    [{ é: 1, Z: 2, a: 3, aa: 4, "": 0 }, "psFj7dEx0yLDzHd3f9mabQ"],
    [
      {
        nested: {
          z: { y: [1, { b: 2, a: 1 }] },
          a: 'line\nbreak "q" \\ \u0001',
        },
      },
      "-F2yA3CkzEaGhmts3kOA3w",
    ],
  ])("%j", (input, expected) => {
    expect(blockVersion(input)).toBe(expected);
  });
});

describe("revisionTimeMs / revisionTimeAfter", () => {
  it("reads the UUIDv7 timestamp back from an id", () => {
    expect(
      revisionTimeMs("fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55"),
    ).toBe(0x0193a1f26800);
    const at = Date.parse("2026-11-03T12:00:00.001Z");
    expect(revisionTimeMs(newRevisionId(at))).toBe(at);
  });

  it("is now, but never before 1 ms after the previous revision", () => {
    const previous = newRevisionId(10_000);
    expect(revisionTimeAfter(null, 5_000)).toBe(5_000);
    expect(revisionTimeAfter(previous, 20_000)).toBe(20_000);
    expect(revisionTimeAfter(previous, 5_000)).toBe(10_001);
    expect(revisionTimeAfter(previous, 10_000)).toBe(10_001);
  });
});
