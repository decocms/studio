import { describe, expect, it } from "bun:test";
import { llmSafeInputSchema } from "./mcp-tools";

describe("llmSafeInputSchema", () => {
  it("passes safe schemas through untouched", () => {
    const schema = { type: "object", properties: { "a.b-c_1": {}, x: {} } };
    const result = llmSafeInputSchema(schema);
    expect(result.schema).toBe(schema);
    expect(result.keyMap.size).toBe(0);
    expect(llmSafeInputSchema({ type: "object" }).schema).toEqual({
      type: "object",
    });
  });

  it("renames unsafe keys, keeps required in sync and maps back", () => {
    const long = `k${"x".repeat(70)}`;
    const { schema, keyMap } = llmSafeInputSchema({
      type: "object",
      properties: { "site/sections/A.tsx": { type: "string" }, [long]: {} },
      required: ["site/sections/A.tsx"],
    });
    const keys = Object.keys(
      (schema as { properties: Record<string, unknown> }).properties,
    );
    expect(keys).toEqual(["site_sections_A.tsx", long.slice(0, 64)]);
    expect((schema as { required: string[] }).required).toEqual([
      "site_sections_A.tsx",
    ]);
    expect(keyMap.get("site_sections_A.tsx")).toBe("site/sections/A.tsx");
    expect(keyMap.get(long.slice(0, 64))).toBe(long);
  });

  it("does not collide with an existing safe key", () => {
    const { schema, keyMap } = llmSafeInputSchema({
      properties: { a_b: {}, "a/b": {} },
    });
    const keys = Object.keys(
      (schema as { properties: Record<string, unknown> }).properties,
    );
    expect(keys).toEqual(["a_b", "a_b_2"]);
    expect(keyMap.get("a_b_2")).toBe("a/b");
  });
});
