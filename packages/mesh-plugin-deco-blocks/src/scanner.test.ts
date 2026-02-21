/**
 * scanner.test.ts
 *
 * Unit tests for scanBlocks(), scanLoaders(), and isDecoSite().
 * Uses in-memory fixture files written to a temp directory.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanBlocks, scanLoaders } from "./scanner.ts";
import { isDecoSite } from "./is-deco-site.ts";

// ============================================================================
// Fixture setup
// ============================================================================

let tmpDir: string;

beforeAll(() => {
  // Create temp directory for fixtures
  tmpDir = mkdtempSync(path.join(tmpdir(), "deco-scanner-test-"));

  // Minimal tsconfig.json
  writeFileSync(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "ESNext",
        target: "ESNext",
      },
    }),
  );

  // Create sections/ and loaders/ and components/ directories
  mkdirSync(path.join(tmpDir, "sections"), { recursive: true });
  mkdirSync(path.join(tmpDir, "loaders"), { recursive: true });
  mkdirSync(path.join(tmpDir, "components"), { recursive: true });

  // 1. sections/ProductShelf.tsx — section with named Props
  writeFileSync(
    path.join(tmpDir, "sections", "ProductShelf.tsx"),
    `export interface Props {
  title: string;
  count?: number;
}
export default function ProductShelf({ title, count = 10 }: Props) {
  return null;
}
`,
  );

  // 2. sections/HeroSection.tsx — section with no props
  writeFileSync(
    path.join(tmpDir, "sections", "HeroSection.tsx"),
    `export default function HeroSection() {
  return null;
}
`,
  );

  // 3. loaders/products.ts — loader with Props and return type
  writeFileSync(
    path.join(tmpDir, "loaders", "products.ts"),
    `export interface Props {
  category: string;
}
export interface Product {
  id: string;
  name: string;
}
const loader = async (props: Props, _req: Request): Promise<Product[]> => {
  return [];
};
export default loader;
`,
  );

  // 4. components/Button.tsx — NO export default (should NOT appear)
  writeFileSync(
    path.join(tmpDir, "components", "Button.tsx"),
    `export function Button() { return null; }
`,
  );
});

afterAll(() => {
  // Clean up temp directory
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// scanBlocks tests
// ============================================================================

describe("scanBlocks", () => {
  it("returns ProductShelf section with kind: section", async () => {
    const blocks = await scanBlocks(tmpDir);
    const shelf = blocks.find((b) => b.name === "ProductShelf");
    expect(shelf).toBeDefined();
    expect(shelf?.kind).toBe("section");
  });

  it("returns HeroSection with kind: section", async () => {
    const blocks = await scanBlocks(tmpDir);
    const hero = blocks.find((b) => b.name === "HeroSection");
    expect(hero).toBeDefined();
    expect(hero?.kind).toBe("section");
  });

  it("HeroSection has empty propsSchema (no Props type)", async () => {
    const blocks = await scanBlocks(tmpDir);
    const hero = blocks.find((b) => b.name === "HeroSection");
    expect(hero).toBeDefined();
    // {} or object with no meaningful properties (no 'properties' key)
    const schema = hero?.propsSchema as Record<string, unknown>;
    expect(typeof schema).toBe("object");
    // Either empty object or schema without required properties
    if ("properties" in schema) {
      expect(Object.keys(schema.properties as object).length).toBe(0);
    }
  });

  it("does NOT return Button (no export default)", async () => {
    const blocks = await scanBlocks(tmpDir);
    const button = blocks.find((b) => b.name === "Button");
    expect(button).toBeUndefined();
  });

  it("each block has name equal to the file stem", async () => {
    const blocks = await scanBlocks(tmpDir);
    for (const block of blocks) {
      const stem = path.basename(block.filePath, path.extname(block.filePath));
      expect(block.name).toBe(stem);
    }
  });

  it("ProductShelf propsSchema has title (string) and count (number) properties", async () => {
    const blocks = await scanBlocks(tmpDir);
    const shelf = blocks.find((b) => b.name === "ProductShelf");
    expect(shelf).toBeDefined();
    const schema = shelf?.propsSchema as Record<string, unknown>;
    // ts-json-schema-generator wraps in definitions + $ref
    // The actual Props definition lives under definitions.Props
    const definitions = schema.definitions as Record<
      string,
      { properties: Record<string, { type: string }> }
    >;
    expect(definitions).toBeDefined();
    const propsDefn = definitions["Props"];
    expect(propsDefn).toBeDefined();
    const properties = propsDefn.properties;
    expect(properties).toBeDefined();
    expect(properties["title"]).toBeDefined();
    expect(properties["title"].type).toBe("string");
    expect(properties["count"]).toBeDefined();
    expect(properties["count"].type).toBe("number");
  });

  it("products loader appears in scanBlocks with kind: loader", async () => {
    const blocks = await scanBlocks(tmpDir);
    const products = blocks.find((b) => b.name === "products");
    expect(products).toBeDefined();
    expect(products?.kind).toBe("loader");
  });
});

// ============================================================================
// scanLoaders tests
// ============================================================================

describe("scanLoaders", () => {
  it("returns products loader with kind: loader", async () => {
    const loaders = await scanLoaders(tmpDir);
    const products = loaders.find((l) => l.name === "products");
    expect(products).toBeDefined();
    expect(products?.kind).toBe("loader");
  });

  it("products loader propsSchema has category (string)", async () => {
    const loaders = await scanLoaders(tmpDir);
    const products = loaders.find((l) => l.name === "products");
    expect(products).toBeDefined();
    const schema = products?.propsSchema as Record<string, unknown>;
    // ts-json-schema-generator wraps in definitions + $ref
    const definitions = schema.definitions as Record<
      string,
      { properties: Record<string, { type: string }> }
    >;
    expect(definitions).toBeDefined();
    const propsDefn = definitions["Props"];
    expect(propsDefn).toBeDefined();
    const properties = propsDefn.properties;
    expect(properties).toBeDefined();
    expect(properties["category"]).toBeDefined();
    expect(properties["category"].type).toBe("string");
  });

  it("products loader returnType is an array schema", async () => {
    const loaders = await scanLoaders(tmpDir);
    const products = loaders.find((l) => l.name === "products");
    expect(products).toBeDefined();
    const returnType = products?.returnType as Record<string, unknown>;
    expect(returnType).toBeDefined();
    // Product[] should have type: "array"
    expect(returnType.type).toBe("array");
  });

  it("does NOT return sections as loaders", async () => {
    const loaders = await scanLoaders(tmpDir);
    // All results from scanLoaders must have kind: "loader"
    // Verify no non-loader sneaked in by checking the count matches
    // (sections/ and components/ files should NOT appear here)
    const nonLoaders = loaders.filter((l) => (l.kind as string) !== "loader");
    expect(nonLoaders.length).toBe(0);
  });

  it("returns only loaders (all results have kind: loader)", async () => {
    const loaders = await scanLoaders(tmpDir);
    for (const loader of loaders) {
      expect(loader.kind).toBe("loader");
    }
  });
});

// ============================================================================
// isDecoSite tests
// ============================================================================

describe("isDecoSite", () => {
  it("returns true for connection with BLOCKS_LIST and LOADERS_LIST tools", () => {
    const connection = {
      tools: [{ name: "BLOCKS_LIST" }, { name: "LOADERS_LIST" }],
    };
    expect(isDecoSite(connection)).toBe(true);
  });

  it("returns false for connection with no tools", () => {
    const connection = { tools: [] };
    expect(isDecoSite(connection)).toBe(false);
  });

  it("returns false for connection with undefined tools", () => {
    const connection = {};
    expect(isDecoSite(connection)).toBe(false);
  });

  it("returns false for connection with different tools", () => {
    const connection = {
      tools: [{ name: "SOME_OTHER_TOOL" }, { name: "ANOTHER_TOOL" }],
    };
    expect(isDecoSite(connection)).toBe(false);
  });

  it("returns false for connection with only BLOCKS_LIST (missing LOADERS_LIST)", () => {
    const connection = {
      tools: [{ name: "BLOCKS_LIST" }],
    };
    expect(isDecoSite(connection)).toBe(false);
  });

  it("returns false for connection with only LOADERS_LIST (missing BLOCKS_LIST)", () => {
    const connection = {
      tools: [{ name: "LOADERS_LIST" }],
    };
    expect(isDecoSite(connection)).toBe(false);
  });
});
