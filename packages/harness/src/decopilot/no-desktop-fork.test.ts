import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("decopilot-desktop fork removal", () => {
  test("the decopilot-desktop directory no longer exists", () => {
    // The fork was collapsed into the unified factory; the directory must stay
    // gone. A filesystem check (rather than a static import of the deleted path)
    // is the guard — it asserts removal without tripping dead-import analysis.
    const dir = new URL("../decopilot-desktop", import.meta.url).pathname;
    expect(existsSync(dir)).toBe(false);
  });
});
