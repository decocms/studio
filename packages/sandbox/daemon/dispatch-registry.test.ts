import { describe, expect, it } from "bun:test";
import { claudeCodeHarnessFactory } from "@decocms/harness/claude-code/index";
import { codexHarnessFactory } from "@decocms/harness/codex/index";
import {
  getHarnessFactory,
  registerHarnessFactory,
  resetRegistryForTests,
} from "@decocms/harness/registry";

// The daemon (entry.ts) registers its harness factories into the shared
// @decocms/harness registry and looks them up by id. The registry keys ARE the
// factory ids, so a factory.id that drifts from the dispatch protocol's harness
// id would silently 404 "unknown harness". Lock the id↔registry-key invariant
// for the package-side CLI factories. (decopilotDesktopHarnessFactory.id =
// "decopilot" lives in apps/mesh — asserted by the desktop-factory definition.)
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
});
