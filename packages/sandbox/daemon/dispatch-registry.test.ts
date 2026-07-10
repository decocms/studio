import { describe, expect, it } from "bun:test";
import { claudeCodeHarnessFactory } from "@decocms/harness/claude-code/index";
import { codexHarnessFactory } from "@decocms/harness/codex/index";
import {
  getHarnessFactory,
  registerHarnessFactory,
  resetRegistryForTests,
} from "@decocms/harness/registry";
import { DISPATCHABLE_HARNESS_IDS } from "./harness-runner/protocol";

// The harness-runner (harness-runner/serve.ts) registers its harness
// factories into the shared @decocms/harness registry and looks them up by
// id. The registry keys ARE the factory ids, so a factory.id that drifts from
// the dispatch protocol's harness id would silently 404 "unknown harness".
// Lock the id↔registry-key invariant for the package-side CLI factories.
// Decopilot is cluster-only and is not registered in the desktop runner.
describe("daemon harness registry (id ↔ key)", () => {
  it("resolves the CLI harness factories by their dispatch id", () => {
    resetRegistryForTests();
    registerHarnessFactory(claudeCodeHarnessFactory);
    registerHarnessFactory(codexHarnessFactory);
    expect(claudeCodeHarnessFactory.id).toBe("claude-code");
    expect(codexHarnessFactory.id).toBe("codex");
    expect(getHarnessFactory("claude-code")).toBe(claudeCodeHarnessFactory);
    expect(getHarnessFactory("codex")).toBe(codexHarnessFactory);
  });

  // The daemon gates /dispatch on DISPATCHABLE_HARNESS_IDS without importing
  // harness code (protocol.ts stays factory-free for the Go rewrite); a drift
  // between that list and the factories the runner registers would 400 or
  // harness_crash valid dispatches.
  it("DISPATCHABLE_HARNESS_IDS matches the registered factory ids", () => {
    expect(new Set(DISPATCHABLE_HARNESS_IDS)).toEqual(
      new Set([claudeCodeHarnessFactory.id, codexHarnessFactory.id]),
    );
  });
});
