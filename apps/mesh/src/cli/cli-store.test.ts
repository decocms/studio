import { beforeEach, describe, expect, test } from "bun:test";
import { getCliState, setDevMode, updateService } from "./cli-store";

// Reset shared module state between tests by re-importing.
// cli-store uses module-level `let state` so tests that mutate it
// would bleed into each other without isolation.
function resetState() {
  // Reach into the store and reset by calling setDevMode with no args
  // won't reset the base services, so we patch directly via the exported setter.
  // Since we can't reset directly, we rely on test order independence by
  // only reading state *after* a fresh setDevMode call in each test.
}

describe("cli-store dev mode services", () => {
  beforeEach(() => {
    // No-op: tests are written to be order-independent by asserting
    // only the additions made in that test.
    resetState();
  });

  test("tracks both Web and API service ports for the TUI", () => {
    setDevMode();

    updateService({ name: "Web", status: "ready", port: 3000 });
    updateService({ name: "API", status: "ready", port: 3001 });

    expect(getCliState().services).toEqual(
      expect.arrayContaining([
        { name: "Web", status: "ready", port: 3000 },
        { name: "API", status: "ready", port: 3001 },
      ]),
    );
  });

  test("includes Sandbox when localSandboxProvider is true", () => {
    setDevMode({ localSandboxProvider: true });
    expect(getCliState().services.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Web", "API", "Sandbox"]),
    );
  });

  test("does not include Sandbox by default", () => {
    setDevMode();
    expect(getCliState().services.map((s) => s.name)).not.toContain("Sandbox");
  });
});
