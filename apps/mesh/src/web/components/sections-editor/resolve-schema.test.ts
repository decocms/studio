import { describe, expect, test } from "bun:test";
import { resolveSchema, type LiveMeta } from "./resolve-schema";

function metaWithSchema(blockSchema: Record<string, unknown>): LiveMeta {
  return {
    manifest: {
      blocks: { sections: { "site/sections/Test.tsx": blockSchema } },
    },
    schema: {},
  };
}

describe("resolveSchema – nullable unions inherit leaf metadata", () => {
  test("preserves format on nullable image field (anyOf: [T, null])", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        image: {
          anyOf: [
            { type: "string", format: "image-uri", title: "Hero image" },
            { type: "null" },
          ],
        },
      },
    });

    const resolved = resolveSchema("site/sections/Test.tsx", meta);
    const image = resolved?.properties?.image;
    expect(image?.type).toBe("string");
    expect(image?.format).toBe("image-uri");
    expect(image?.title).toBe("Hero image");
  });

  test("preserves format on nullable file field", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        attachment: {
          anyOf: [{ type: "string", format: "file-uri" }, { type: "null" }],
        },
      },
    });

    const file = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.attachment;
    expect(file?.format).toBe("file-uri");
  });

  test("direct format (no union) still works", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        image: { type: "string", format: "image-uri" },
      },
    });
    expect(
      resolveSchema("site/sections/Test.tsx", meta)?.properties?.image?.format,
    ).toBe("image-uri");
  });
});
