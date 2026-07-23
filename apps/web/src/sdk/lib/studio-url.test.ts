import { describe, expect, test } from "bun:test";
import { resolveStudioUrl } from "./studio-url";

describe("resolveStudioUrl", () => {
  test("prefers studioUrl when both names are provided", () => {
    expect(
      resolveStudioUrl({
        studioUrl: "https://studio.example.com",
        meshUrl: "https://legacy.example.com",
      }),
    ).toBe("https://studio.example.com");
  });

  test("accepts meshUrl as a backwards-compatible alias", () => {
    expect(
      resolveStudioUrl({
        meshUrl: "https://legacy.example.com",
      }),
    ).toBe("https://legacy.example.com");
  });

  test("uses the fallback when neither option is provided", () => {
    expect(resolveStudioUrl({}, "https://fallback.example.com")).toBe(
      "https://fallback.example.com",
    );
  });
});
