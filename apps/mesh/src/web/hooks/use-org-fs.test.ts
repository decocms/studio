import { describe, expect, test } from "bun:test";
import { entryMarker } from "./use-org-fs";

describe("entryMarker", () => {
  test("prefers contentHash when present", () => {
    expect(
      entryMarker({
        size: 10,
        updatedAt: "2026-01-01T00:00:00Z",
        contentHash: "abc123",
      }),
    ).toBe("abc123");
  });

  test("falls back to size-updatedAt when contentHash is null", () => {
    expect(
      entryMarker({
        size: 10,
        updatedAt: "2026-01-01T00:00:00Z",
        contentHash: null,
      }),
    ).toBe("10-2026-01-01T00:00:00Z");
  });

  test("falls back to size-updatedAt when contentHash is undefined", () => {
    expect(
      entryMarker({
        size: 5,
        updatedAt: "2026-02-02T00:00:00Z",
      }),
    ).toBe("5-2026-02-02T00:00:00Z");
  });
});
