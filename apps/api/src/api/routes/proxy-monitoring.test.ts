import { describe, expect, it } from "bun:test";
import {
  extractCallToolErrorMessage,
  extractMetaProperties,
} from "./proxy-monitoring";

describe("extractCallToolErrorMessage", () => {
  it("returns undefined for a malformed downstream result instead of throwing", () => {
    expect(extractCallToolErrorMessage(null as any)).toBeUndefined();
    expect(extractCallToolErrorMessage(undefined as any)).toBeUndefined();
    expect(extractCallToolErrorMessage("nope" as any)).toBeUndefined();
  });

  it("extracts the text content when isError is set", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: "boom" }],
    } as any;
    expect(extractCallToolErrorMessage(result)).toBe("boom");
  });
});

describe("extractMetaProperties", () => {
  it("drops a value over the per-property length cap", () => {
    const result = extractMetaProperties({
      _meta: { properties: { ok: "fine", huge: "x".repeat(501) } },
    });
    expect(result).toEqual({ ok: "fine" });
  });

  it("caps the number of properties a caller can set", () => {
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`k${i}`, `v${i}`]),
    );
    const result = extractMetaProperties({ _meta: { properties: many } });
    expect(Object.keys(result ?? {}).length).toBe(50);
  });
});
