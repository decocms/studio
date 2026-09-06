import { describe, expect, it } from "bun:test";
import { extractCallToolErrorMessage } from "./proxy-monitoring";

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
