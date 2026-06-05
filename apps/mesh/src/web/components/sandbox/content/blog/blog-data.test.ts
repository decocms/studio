import { describe, expect, test } from "bun:test";
import { blockComponentName } from "./blog-data";

describe("blockComponentName", () => {
  test("extracts from standard blog block paths", () => {
    expect(blockComponentName("blog/sections/blocks/Paragraph.tsx")).toBe(
      "Paragraph",
    );
  });

  test("extracts from site-specific blog block paths", () => {
    expect(blockComponentName("site/sections/Blog/Post/Paragraph.tsx")).toBe(
      "Paragraph",
    );
    expect(blockComponentName("site/sections/Blog/Post/ProductCard.tsx")).toBe(
      "ProductCard",
    );
  });

  test("strips .ts and .jsx extensions", () => {
    expect(blockComponentName("blog/sections/blocks/Code.ts")).toBe("Code");
    expect(blockComponentName("blog/sections/blocks/Video.jsx")).toBe("Video");
  });
});
