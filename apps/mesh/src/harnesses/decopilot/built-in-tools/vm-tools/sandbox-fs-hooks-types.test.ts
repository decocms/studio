import { describe, expect, it } from "bun:test";
// Tests MAY import @decocms/sandbox (only PRODUCTION harness files must be
// sandbox-free). This file is the drift detector: the harness-owned
// SandboxFsHooks mirrors the sandbox-side interface, and the two must stay
// structurally identical until the package move (spec Phase 5) collapses them.
import type { SandboxFsHooks as SandboxOwned } from "@decocms/sandbox/provider";
import type { SandboxFsHooks as HarnessOwned } from "./sandbox-fs-hooks-types";

describe("SandboxFsHooks structural parity with @decocms/sandbox", () => {
  it("stays mutually assignable (compile-time, enforced by `bun run check`)", () => {
    // These assignments fail to TYPECHECK if either side drifts in shape.
    // `bun test` strips types, so the real enforcement is `tsc --noEmit`
    // (the `check` script); the runtime body just keeps the test non-empty.
    const harnessToSandbox = (h: HarnessOwned): SandboxOwned => h;
    const sandboxToHarness = (s: SandboxOwned): HarnessOwned => s;
    expect(typeof harnessToSandbox).toBe("function");
    expect(typeof sandboxToHarness).toBe("function");
  });
});
