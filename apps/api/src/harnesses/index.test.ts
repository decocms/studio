import { beforeAll, describe, expect, test } from "bun:test";
import {
  getHarnessFactory,
  registerHarnessFactory,
} from "@decocms/harness/registry";
import { decopilotHarnessFactory } from "@decocms/harness/decopilot/index";

describe("harness registration", () => {
  // Re-register explicitly here so the test doesn't depend on test-file
  // ordering. Other test files (e.g. local-dispatch.test.ts, registry.test.ts)
  // call `resetRegistryForTests()` to isolate their own state, which clears
  // the module-load side-effect registrations done by `./index`.
  beforeAll(() => {
    registerHarnessFactory(decopilotHarnessFactory);
  });

  test("decopilot is registered", () => {
    expect(getHarnessFactory("decopilot")?.id).toBe("decopilot");
  });

  test("cluster harness registration does not register desktop Decopilot builder", async () => {
    const source = await Bun.file("apps/api/src/harnesses/index.ts").text();
    expect(source).not.toContain("registerDesktopEnvironmentBuilder");
    expect(source).not.toContain("buildDesktopEnvironmentTools");
  });
});
