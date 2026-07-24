import { resolveBindingType } from "@/hooks/use-binding";
import { describe, expect, it } from "bun:test";

describe("resolveBindingType", () => {
  it("should resolve @deco/llm to LLMS", () => {
    expect(resolveBindingType("@deco/llm")).toBe("LLMS");
  });

  it("should return undefined for unknown binding types", () => {
    expect(resolveBindingType("@deco/unknown")).toBeUndefined();
    expect(resolveBindingType("@other/something")).toBeUndefined();
  });

  it("should return undefined for undefined input", () => {
    expect(resolveBindingType(undefined)).toBeUndefined();
  });

  it("should not resolve @deco/language-model (handled by dedicated ModelSelector)", () => {
    expect(resolveBindingType("@deco/language-model")).toBeUndefined();
  });

  it("should not resolve @deco/agent (handled by dedicated VirtualMCPSelector)", () => {
    expect(resolveBindingType("@deco/agent")).toBeUndefined();
  });
});
