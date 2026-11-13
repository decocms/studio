import { describe, expect, test } from "bun:test";
import { omitServerManagedMetadata } from "./omit-server-managed-metadata";

describe("omitServerManagedMetadata", () => {
  test("keeps user metadata without mutating lifecycle state", () => {
    const metadata = {
      instructions: "Keep me",
      sandboxMap: { user: { branch: {} } },
    };

    expect(Object.keys(omitServerManagedMetadata(metadata))).toEqual([
      "instructions",
    ]);
    expect(metadata).toHaveProperty("sandboxMap");
  });

  test("never sends back the Blocks v8 site switch it read", () => {
    const metadata: Record<string, unknown> = {
      instructions: "x",
      blocksV8: true,
    };
    expect(omitServerManagedMetadata(metadata)).toEqual({ instructions: "x" });
  });
});
