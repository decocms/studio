import { describe, expect, it } from "bun:test";
import { draftVersionOf } from "./draft-version";

/**
 * The contract's §1.3 vectors: the hosted CMS's `blockVersion`, the same
 * table the API's `revision-id.test.ts` checks the server against.
 */
describe("draftVersionOf (a hosted draft block's version, from the block)", () => {
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
  ])("%j", async (input, expected) => {
    expect(await draftVersionOf(input)).toBe(expected);
  });

  it("changes with any value of the block", async () => {
    expect(await draftVersionOf({ title: "a" })).not.toBe(
      await draftVersionOf({ title: "b" }),
    );
  });
});
