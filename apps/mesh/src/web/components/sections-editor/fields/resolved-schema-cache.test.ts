import { describe, expect, it } from "bun:test";
import { cachedResolveSchema } from "./resolved-schema-cache";
import type { LiveMeta } from "../resolve-schema";

describe("cachedResolveSchema", () => {
  it("does not leak a resolveType's schema across different meta (site) instances", () => {
    // Built-in matcher resolveTypes are identical strings across every deco
    // site — only `meta` (site A vs. site B) tells them apart.
    const resolveType = "website/matchers/MatchDevice.ts";
    const metaA: LiveMeta = {
      manifest: {
        blocks: { matchers: { [resolveType]: { $ref: "#/definitions/A" } } },
      },
      schema: {
        $defs: {
          A: {
            type: "object",
            title: "A",
            properties: { a: { type: "string" } },
          },
        },
      },
    };
    const metaB: LiveMeta = {
      manifest: {
        blocks: { matchers: { [resolveType]: { $ref: "#/definitions/B" } } },
      },
      schema: {
        $defs: {
          B: {
            type: "object",
            title: "B",
            properties: { b: { type: "number" } },
          },
        },
      },
    };

    const resultA = cachedResolveSchema(resolveType, metaA);
    const resultB = cachedResolveSchema(resolveType, metaB);

    expect(Object.keys(resultA?.properties ?? {})).toEqual(["a"]);
    expect(Object.keys(resultB?.properties ?? {})).toEqual(["b"]);
  });
});
