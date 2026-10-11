import { describe, expect, test } from "bun:test";
import type { ContentBackend } from "./content-backend";
import { serveChipTone } from "./deco-serve-chip";

const unavailable = (reason?: string): ContentBackend =>
  ({
    kind: "unavailable",
    source: "local",
    ...(reason ? { problem: { reason } } : {}),
  }) as ContentBackend;

describe("serveChipTone (the Local server chip)", () => {
  test("connecting or waiting for deco serve is pending, never red", () => {
    expect(serveChipTone({ kind: "pending" })).toBe("pending");
    expect(serveChipTone(unavailable())).toBe("pending");
    expect(serveChipTone(unavailable("not-answering"))).toBe("pending");
  });

  test("red only when something answered and can't be used", () => {
    for (const reason of [
      "outdated",
      "version-mismatch",
      "not-deco-serve",
      "error",
    ]) {
      expect(serveChipTone(unavailable(reason))).toBe("failure");
    }
  });

  test("connected is ok", () => {
    expect(
      serveChipTone({ kind: "protocol", source: "local" } as ContentBackend),
    ).toBe("ok");
  });
});
