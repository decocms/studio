import { describe, expect, test } from "bun:test";
import { stripServerManagedMetadata } from "./strip-server-managed-metadata";

describe("stripServerManagedMetadata", () => {
  test("removes sandboxMap without mutating the caller's metadata", () => {
    const metadata = {
      instructions: "Keep me",
      sandboxMap: { user: { branch: {} } },
    };

    expect(stripServerManagedMetadata(metadata)).toEqual({
      instructions: "Keep me",
    });
    expect(metadata).toHaveProperty("sandboxMap");
  });

  test("preserves null and undefined", () => {
    expect(stripServerManagedMetadata(null)).toBeNull();
    expect(stripServerManagedMetadata(undefined)).toBeUndefined();
  });
});
