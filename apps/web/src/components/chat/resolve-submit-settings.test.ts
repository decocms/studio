import { describe, expect, test } from "bun:test";

import { resolveSubmitSettings } from "./resolve-submit-settings";

describe("resolveSubmitSettings", () => {
  const globals = {
    harnessId: "codex" as const,
    sandboxProviderKind: "user-desktop" as const,
    branch: "feature-x",
  };

  test("no active thread: returns all three from globals", () => {
    const out = resolveSubmitSettings({ thread: null, globals });
    expect(out).toEqual({
      harnessId: "codex",
      sandboxProviderKind: "user-desktop",
      branch: "feature-x",
    });
  });

  test("legacy thread with harness_id null: returns all three from globals", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: null,
        sandbox_provider_kind: null,
        branch: null,
      },
      globals,
    });
    expect(out).toEqual({
      harnessId: "codex",
      sandboxProviderKind: "user-desktop",
      branch: "feature-x",
    });
  });

  test("locked thread: omits all three fields entirely (server reads from row)", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "claude-code",
        sandbox_provider_kind: "user-desktop",
        branch: "main",
      },
      globals,
    });
    expect(out).toEqual({});
  });

  test("locked thread with null sandbox/branch: still omits everything", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "decopilot",
        sandbox_provider_kind: null,
        branch: null,
      },
      globals,
    });
    expect(out).toEqual({});
  });

  test("locked thread overrides aggressive globals (proves client-side strip)", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "codex",
        sandbox_provider_kind: "user-desktop",
        branch: "main",
      },
      globals: {
        harnessId: "claude-code",
        sandboxProviderKind: "user-desktop",
        branch: "different-branch",
      },
    });
    expect(Object.keys(out)).toEqual([]);
  });

  test("no active thread + no globals: returns empty undefined-valued fields", () => {
    const out = resolveSubmitSettings({
      thread: null,
      globals: {
        harnessId: undefined,
        sandboxProviderKind: undefined,
        branch: null,
      },
    });
    expect(out).toEqual({
      harnessId: undefined,
      sandboxProviderKind: undefined,
      branch: null,
    });
  });
});
