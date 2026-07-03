import { describe, expect, test } from "bun:test";
import { formatBytes } from "./format-bytes.ts";

describe("formatBytes", () => {
  test("formats sub-KB sizes as bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("formats KB with one decimal below 10 KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  test("formats KB rounded above 10 KB", () => {
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(500 * 1024)).toBe("500 KB");
  });

  test("formats MB with one decimal below 10 MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
  });

  test("formats MB rounded above 10 MB", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
  });
});
