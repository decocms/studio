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

  // Inverted from "claude-code/codex are registered". The gate
  // (`assertHarnessRunsInCluster`) throws for both before any lookup, so a
  // registration here would be unreachable. Registering one again without
  // giving it a cluster host should fail this test, not pass silently.
  test.each(["claude-code", "codex"] as const)(
    "CLI harness %s is NOT registered in the cluster",
    (id) => {
      expect(getHarnessFactory(id)).toBeUndefined();
    },
  );

  test("cluster harness barrel does not import the CLI harness factories", async () => {
    const source = await Bun.file("apps/api/src/harnesses/index.ts").text();
    expect(source).not.toContain("claudeCodeHarnessFactory");
    expect(source).not.toContain("codexHarnessFactory");
  });

  test("cluster harness registration does not register desktop Decopilot builder", async () => {
    const source = await Bun.file("apps/api/src/harnesses/index.ts").text();
    expect(source).not.toContain("registerDesktopEnvironmentBuilder");
    expect(source).not.toContain("buildDesktopEnvironmentTools");
  });
});
