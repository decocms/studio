import { describe, expect, it } from "bun:test";
import { resolveDaemonImpl } from "./resolve-daemon-impl";

describe("resolveDaemonImpl", () => {
  it("defaults to ts with no prop and no flag", () => {
    expect(resolveDaemonImpl({})).toBe("ts");
    expect(resolveDaemonImpl({ flags: null })).toBe("ts");
    expect(resolveDaemonImpl({ flags: {} })).toBe("ts");
  });

  it("honors the org flag", () => {
    expect(resolveDaemonImpl({ flags: { sandbox_go_daemon: true } })).toBe(
      "go",
    );
    expect(resolveDaemonImpl({ flags: { sandbox_go_daemon: false } })).toBe(
      "ts",
    );
  });

  it("lets the explicit prop win in both directions", () => {
    expect(
      resolveDaemonImpl({
        explicit: "go",
        flags: { sandbox_go_daemon: false },
      }),
    ).toBe("go");
    // The escape hatch that matters most: pinning one sandbox back to ts
    // inside an org that is otherwise on Go.
    expect(
      resolveDaemonImpl({ explicit: "ts", flags: { sandbox_go_daemon: true } }),
    ).toBe("ts");
  });
});
