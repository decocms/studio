import { describe, expect, it } from "bun:test";
import {
  parseStudioStorageKey,
  studioStorageRegex,
  toStudioStorageUri,
} from "./studio-storage-uri";

describe("studio-storage-uri (harness leaf)", () => {
  it("round-trips a key through the scheme", () => {
    const uri = toStudioStorageUri("org/abc.png");
    expect(uri).toBe("studio-storage://org/abc.png");
    expect(parseStudioStorageKey(uri)).toBe("org/abc.png");
  });
  it("returns null for a non-storage URI", () => {
    expect(parseStudioStorageKey("https://example.com/x")).toBeNull();
  });
  it("still parses persisted legacy mesh-storage:// URIs identically", () => {
    expect(parseStudioStorageKey("mesh-storage://org/abc.png")).toBe(
      "org/abc.png",
    );
    expect(
      parseStudioStorageKey("mesh-storage://_fs/uploads/thread-1/report.pdf"),
    ).toBe("_fs/uploads/thread-1/report.pdf");
  });
  it("regex matches both schemes and captures the key", () => {
    const text =
      "old mesh-storage://a/b.png and new studio-storage://c/d.png here";
    const keys = [...text.matchAll(studioStorageRegex())].map((m) => m[1]);
    expect(keys).toEqual(["a/b.png", "c/d.png"]);
  });
});
