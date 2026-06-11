import { describe, expect, test } from "bun:test";

describe("decopilot-desktop fork removal", () => {
  test("the decopilot-desktop module no longer resolves", async () => {
    await expect(
      // @ts-expect-error - the decopilot-desktop fork is deleted; this module
      // must no longer resolve (the unified factory is canonical). The static
      // error here IS the guard: if the directory ever returns, tsc stops
      // erroring and @ts-expect-error itself fails the build.
      import("../decopilot-desktop/index"),
    ).rejects.toThrow();
  });
});
