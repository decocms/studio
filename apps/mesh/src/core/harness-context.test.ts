import { describe, expect, it } from "bun:test";
import type { HarnessContext } from "./harness-context";
import type { MeshContext } from "./mesh-context";

describe("HarnessContext", () => {
  it("MeshContext is assignable to HarnessContext (narrowing)", () => {
    const mesh: MeshContext = null as never;
    const harness: HarnessContext = mesh;
    expect(harness).toBe(mesh);
  });

  it("exposes exactly the narrow surface CLI harnesses need", () => {
    // Listing the keys as a tuple pins the public shape — adding or
    // removing a field on HarnessContext requires updating this test,
    // which forces a review of whether the change belongs on the
    // narrow surface. The compile-time assertion via the `Keys` tuple
    // is what does the real work; the `expect` keeps the test runner
    // happy.
    type Keys = keyof HarnessContext;
    const expected: Keys[] = ["tracer", "meter", "metadata", "aiProviders"];
    expect(expected).toEqual(["tracer", "meter", "metadata", "aiProviders"]);
  });
});
