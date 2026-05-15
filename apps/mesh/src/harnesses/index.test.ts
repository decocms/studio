import { beforeAll, describe, expect, test } from "bun:test";
import { claudeCodeHarnessFactory } from "./claude-code";
import { codexHarnessFactory } from "./codex";
import { decopilotHarnessFactory } from "./decopilot";
import { getHarnessFactory, registerHarnessFactory } from "./registry";

describe("harness registration", () => {
  // Re-register explicitly here so the test doesn't depend on test-file
  // ordering. Other test files (e.g. local-dispatch.test.ts, registry.test.ts)
  // call `resetRegistryForTests()` to isolate their own state, which clears
  // the module-load side-effect registrations done by `./index`.
  beforeAll(() => {
    registerHarnessFactory(decopilotHarnessFactory);
    registerHarnessFactory(claudeCodeHarnessFactory);
    registerHarnessFactory(codexHarnessFactory);
  });

  test("decopilot is registered", () => {
    expect(getHarnessFactory("decopilot")?.id).toBe("decopilot");
  });

  test("claude-code is registered", () => {
    expect(getHarnessFactory("claude-code")?.id).toBe("claude-code");
  });

  test("codex is registered", () => {
    expect(getHarnessFactory("codex")?.id).toBe("codex");
  });
});
