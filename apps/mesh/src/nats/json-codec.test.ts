import { describe, expect, test } from "bun:test";
import { jsonCodec } from "./json-codec";

describe("jsonCodec", () => {
  test("round-trips a value", () => {
    const codec = jsonCodec<{ a: number; b: string[] }>();
    const value = { a: 1, b: ["x", "y"] };
    const bytes = codec.encode(value);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(codec.decode(bytes)).toEqual(value);
  });

  test("encodes as UTF-8 JSON bytes (matches TextEncoder(JSON.stringify))", () => {
    const codec = jsonCodec<unknown[]>();
    const value = [{ name: "héllo" }, 42];
    expect(codec.encode(value)).toEqual(
      new TextEncoder().encode(JSON.stringify(value)),
    );
  });

  test("decodes UTF-8 JSON bytes produced externally", () => {
    const codec = jsonCodec<{ ok: boolean }>();
    const bytes = new TextEncoder().encode(JSON.stringify({ ok: true }));
    expect(codec.decode(bytes)).toEqual({ ok: true });
  });
});
