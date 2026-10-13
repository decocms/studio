import { describe, expect, test } from "bun:test";
import { resolveSchema, type LiveMeta } from "./resolve-schema";

/**
 * Next-major Blocks names block types with short keys (`hero`, `banner`), and
 * `deco schema` writes each as a flat definition whose `__resolveType` enum is
 * that key. They are blocks, not embedded unions, even without a `/`.
 */
describe("resolveSchema – short block type names", () => {
  const meta: LiveMeta = {
    manifest: {
      blocks: {
        sections: {
          page: { $ref: "#/definitions/cGFnZQ==" },
          hero: { $ref: "#/definitions/aGVybw==" },
          banner: { $ref: "#/definitions/YmFubmVy" },
        },
      },
    },
    schema: {
      definitions: {
        Resolvable: { title: "Resolvable" },
        "cGFnZQ==": {
          title: "page",
          type: "object",
          properties: {
            __resolveType: { type: "string", enum: ["page"] },
            hero: {
              title: "Hero",
              anyOf: [
                { $ref: "#/definitions/Resolvable" },
                { $ref: "#/definitions/aGVybw==" },
                { $ref: "#/definitions/YmFubmVy" },
              ],
            },
          },
        },
        "aGVybw==": {
          title: "hero",
          type: "object",
          properties: {
            __resolveType: { type: "string", enum: ["hero"] },
            title: { type: "string" },
          },
        },
        YmFubmVy: {
          title: "banner",
          type: "object",
          properties: {
            __resolveType: { type: "string", enum: ["banner"] },
            image: { type: "string", format: "image-uri" },
          },
        },
      },
    },
  };

  test("offers every block that fits, by its short name", () => {
    const field = resolveSchema("page", meta)?.properties?.hero;
    expect(field?.type).toBe("block-ref");
    expect(field?.anyOfRefs?.map((ref) => ref.resolveType)).toEqual([
      "hero",
      "banner",
    ]);
    expect(field?.anyOfRefs?.[0]?.discriminatorValue).toBeUndefined();
  });
});
