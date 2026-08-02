import { describe, expect, it } from "bun:test";
import { resolveDaemonImpl } from "./resolve-daemon-impl";

describe("resolveDaemonImpl", () => {
  it("defaults to go with no prop and no flag", () => {
    expect(resolveDaemonImpl({})).toBe("go");
    expect(resolveDaemonImpl({ flags: null })).toBe("go");
    expect(resolveDaemonImpl({ flags: {} })).toBe("go");
  });

  it("treats the org flag as an opt-out, not an opt-in", () => {
    expect(resolveDaemonImpl({ flags: { sandbox_go_daemon: false } })).toBe(
      "ts",
    );
    expect(resolveDaemonImpl({ flags: { sandbox_go_daemon: true } })).toBe(
      "go",
    );
  });

  it("lets the explicit prop win in both directions", () => {
    expect(
      resolveDaemonImpl({
        explicit: "go",
        flags: { sandbox_go_daemon: false },
      }),
    ).toBe("go");
    // The escape hatch that matters most now that Go is the default: pinning
    // one sandbox back to ts without opting the whole org out.
    expect(resolveDaemonImpl({ explicit: "ts" })).toBe("ts");
  });
});
