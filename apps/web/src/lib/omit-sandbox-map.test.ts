import { describe, expect, test } from "bun:test";
import { omitSandboxMap } from "./omit-sandbox-map";

describe("omitSandboxMap", () => {
  test("keeps user metadata without mutating lifecycle state", () => {
    const metadata = {
      instructions: "Keep me",
      sandboxMap: { user: { branch: {} } },
    };

    expect(Object.keys(omitSandboxMap(metadata))).toEqual(["instructions"]);
    expect(metadata).toHaveProperty("sandboxMap");
  });
});
