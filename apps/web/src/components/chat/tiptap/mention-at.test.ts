import { describe, expect, test } from "bun:test";
import { resourceDisplayName } from "./mention-at";

describe("resourceDisplayName", () => {
  test("uses the resource's name when present", () => {
    expect(resourceDisplayName("file:///a", "a.txt")).toBe("a.txt");
  });

  test("falls back to the uri when name is undefined", () => {
    expect(resourceDisplayName("file:///a", undefined)).toBe("file:///a");
  });

  test("falls back to the uri when name is an empty string", () => {
    expect(resourceDisplayName("file:///a", "")).toBe("file:///a");
  });
});
