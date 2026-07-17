import { describe, expect, it } from "bun:test";
import { parseSelfToolResult } from "./self-tool-result.ts";

describe("parseSelfToolResult", () => {
  it("returns structuredContent when present", () => {
    const result = parseSelfToolResult<{ triggered: boolean }>({
      structuredContent: { triggered: true },
    });
    expect(result).toEqual({ triggered: true });
  });

  it("falls back to the raw result when there is no structuredContent", () => {
    const raw = { item: { id: "abc" } };
    expect(parseSelfToolResult<typeof raw>(raw)).toBe(raw);
  });

  it("throws the first content text message when isError is set", () => {
    expect(() =>
      parseSelfToolResult({
        isError: true,
        content: [{ text: "Site já reivindicado" }],
      }),
    ).toThrow("Site já reivindicado");
  });

  it("skips content entries without text and uses the first that has it", () => {
    expect(() =>
      parseSelfToolResult({
        isError: true,
        content: [{}, { text: "mensagem real" }],
      }),
    ).toThrow("mensagem real");
  });

  it("throws the default message when isError is set with no usable content", () => {
    expect(() => parseSelfToolResult({ isError: true })).toThrow(
      "A configuração do Commerce Discovery falhou.",
    );
  });

  it("does not throw when isError is falsy even with an error-shaped payload", () => {
    const raw = { content: [{ text: "not an error" }] };
    expect(parseSelfToolResult<typeof raw>(raw)).toBe(raw);
  });
});
