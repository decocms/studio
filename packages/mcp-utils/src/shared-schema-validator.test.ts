import { describe, expect, it } from "bun:test";
import { sharedJsonSchemaValidator } from "./shared-schema-validator";

describe("sharedJsonSchemaValidator", () => {
  it("returns valid:true with the input as data on a matching schema", () => {
    const validator = sharedJsonSchemaValidator.getValidator<{ name: string }>({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });

    const result = validator({ name: "deco" });
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ name: "deco" });
    expect(result.errorMessage).toBeUndefined();
  });

  it("returns valid:false with a non-empty errorMessage on a schema mismatch", () => {
    const validator = sharedJsonSchemaValidator.getValidator({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });

    const result = validator({ name: 42 });
    expect(result.valid).toBe(false);
    expect(result.data).toBeUndefined();
    expect(typeof result.errorMessage).toBe("string");
    expect(result.errorMessage?.length).toBeGreaterThan(0);
  });

  it("validates structurally-identical schemas with different key order and different object identity the same way", () => {
    const a = sharedJsonSchemaValidator.getValidator<{ a: number; b: string }>({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "string" } },
      required: ["a", "b"],
    });
    const b = sharedJsonSchemaValidator.getValidator<{ a: number; b: string }>({
      required: ["a", "b"],
      properties: { b: { type: "string" }, a: { type: "number" } },
      type: "object",
    });

    expect(a({ a: 1, b: "x" }).valid).toBe(true);
    expect(b({ a: 1, b: "x" }).valid).toBe(true);
    expect(a({ a: "not a number", b: "x" }).valid).toBe(false);
    expect(b({ a: "not a number", b: "x" }).valid).toBe(false);
  });

  it("returns a stable validator function per schema object reference", () => {
    const schema = { type: "string" };
    const first = sharedJsonSchemaValidator.getValidator(schema);
    const second = sharedJsonSchemaValidator.getValidator(schema);
    expect(first).toBe(second);
  });
});
