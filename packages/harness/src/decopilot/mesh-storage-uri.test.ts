import { describe, expect, it } from "bun:test";
import { parseMeshStorageKey, toMeshStorageUri } from "./mesh-storage-uri";

describe("mesh-storage-uri (harness leaf)", () => {
  it("round-trips a key through the scheme", () => {
    const uri = toMeshStorageUri("org/abc.png");
    expect(uri).toBe("mesh-storage://org/abc.png");
    expect(parseMeshStorageKey(uri)).toBe("org/abc.png");
  });
  it("returns null for a non-mesh-storage URI", () => {
    expect(parseMeshStorageKey("https://example.com/x")).toBeNull();
  });
});
