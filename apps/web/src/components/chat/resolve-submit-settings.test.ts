import { describe, expect, test } from "bun:test";

import { resolveSubmitSettings } from "./resolve-submit-settings";

describe("resolveSubmitSettings", () => {
  const globals = { branch: "feature-x" };

  test("no active thread: pins hosted Decopilot and carries the branch", () => {
    const out = resolveSubmitSettings({ thread: null, globals });
    expect(out).toEqual({
      harnessId: "decopilot",
      sandboxProviderKind: "agent-sandbox",
      branch: "feature-x",
    });
  });

  test("legacy thread with harness_id null: pins hosted Decopilot", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: null,
        sandbox_provider_kind: null,
        branch: null,
      },
      globals,
    });
    expect(out).toEqual({
      harnessId: "decopilot",
      sandboxProviderKind: "agent-sandbox",
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

  test("locked thread strips the hosted defaults", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "codex",
        sandbox_provider_kind: "user-desktop",
        branch: "main",
      },
      globals: { branch: "different-branch" },
    });
    expect(Object.keys(out)).toEqual([]);
  });

  test("no active thread + no branch: still pins hosted Decopilot", () => {
    const out = resolveSubmitSettings({
      thread: null,
      globals: { branch: null },
    });
    expect(out).toEqual({
      harnessId: "decopilot",
      sandboxProviderKind: "agent-sandbox",
      branch: null,
    });
  });
});
